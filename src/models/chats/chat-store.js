
const { observable, action, computed, reaction, runInAction, autorunAsync, when, isObservableArray } = require('mobx');
const Chat = require('./chat');
const socket = require('../../network/socket');
const tracker = require('../update-tracker');
const EventEmitter = require('eventemitter3');
const _ = require('lodash');
const { retryUntilSuccess } = require('../../helpers/retry');
const MyChats = require('../chats/my-chats');
const TinyDb = require('../../db/tiny-db');
const config = require('../../config');
const User = require('../../models/user/user');
const { asPromise } = require('../../helpers/prombservable');

class ChatStore {
    // todo: not sure this little event emmiter experiment should live
    EVENT_TYPES = {
        messagesReceived: 'messagesReceived'
    };
    events = new EventEmitter();

    @observable chats = observable.shallowArray([]);

    @observable unreadChatsAlwaysOnTop = false;

    myChats;

    // to prevent duplicates
    chatMap = {};
    // when chat list loading is in progress
    @observable loading = false;
    // currently selected/focused chat
    @observable activeChat = null;
    // chats set this flag and UI should use it to prevent user from spam-clicking the 'hide' button
    @observable hidingChat = false;
    // loadAllChats() was called and finished once already
    @observable loaded = false;

    @computed get unreadMessages() {
        return this.chats.reduce((acc, curr) => acc + curr.unreadCount, 0);
    }

    constructor() {
        reaction(() => this.activeChat, chat => {
            if (chat) chat.loadMessages();
        });

        autorunAsync(() => {
            this.sortChats();
        }, 500);
        socket.onceAuthenticated(async () => {
            this.unreadChatsAlwaysOnTop = !!(await TinyDb.user.getValue('pref_unreadChatsAlwaysOnTop'));
            autorunAsync(() => {
                TinyDb.user.setValue('pref_unreadChatsAlwaysOnTop', this.unreadChatsAlwaysOnTop);
            }, 2000);
        });
    }

    sortChats() {
        const array = this.chats;
        for (let i = 1; i < array.length; i++) {
            const item = array[i];
            let indexHole = i;
            while (
                indexHole > 0
                && ChatStore.compareChats(array[indexHole - 1], item, this.unreadChatsAlwaysOnTop) > 0
            ) {
                array[indexHole] = array[--indexHole];
            }
            array[indexHole] = item;
        }
    }

    static compareChats(a, b, unreadOnTop) {
        if (a.isFavorite) {
            // favorite chats are sorted by name
            if (b.isFavorite) {
                return a.name.localeCompare(b.name);
            }
            // a is fav, b is not fav
            return -1;
        } else if (!b.isFavorite) {
            // non favorite chats sort by a weird combination unread count and then by update time
            if (unreadOnTop) {
                // we want chats with unread count > 0 to always come first
                if (a.unreadCount > 0 && b.unreadCount === 0) return -1;
                if (b.unreadCount > 0 && a.unreadCount === 0) return 1;
            }
            // if both chats have unread message - then sort by update time
            const amsg = a.mostRecentMessage;
            const bmsg = b.mostRecentMessage;
            if (!amsg) {
                if (!bmsg) return 0;
                return 1;
            } else if (!bmsg) {
                return -1;
            }
            return amsg.timestamp > bmsg.timestamp ? -1 : 1;
        }
        // a is not fav, b is fav
        return 1;
    }


    onNewMessages = _.throttle((props) => {
        this.events.emit(this.EVENT_TYPES.messagesReceived, props);
    }, 1000);

    addChat = (id, unhide) => {
        if (!id) throw new Error(`Invalid chat id. ${id}`);
        if (id === 'SELF' || !!this.chatMap[id]) return;

        if (!unhide && this.myChats.hidden.includes(id)) {
            // this might be a chat unhidden on another device, give unhidden state some time to propagate
            setTimeout(() => {
                // ok, unhidden by other device, adding chat
                if (!this.myChats.hidden.includes(id)) {
                    this.addChat(id);
                    return;
                }
                // still not unhidden, should we unhide it bcs of new messages?
                const digest = tracker.getDigest(id, 'message');
                // nope, nothing new
                if (digest.maxUpdateId <= digest.knownUpdateId) return;
                this.addChat(id, true);
            }, 2000);
            return;
        }
        const c = new Chat(id, undefined, this);
        if (this.myChats.favorites.includes(id)) c.isFavorite = true;
        this.chatMap[id] = c;
        this.chats.push(c);
        tracker.registerDbInstance(id);
        if (unhide && this.myChats.hidden.includes(id)) c.unhide();
        c.loadMetadata().then(() => c.loadMostRecentMessage());
    };

    // takes current fav/hidden lists and makes sure store.chats reflect it
    // at first login this class and chat list loader will call this function once each making sure data is applied
    @action.bound applyMyChatsData() {
        // resetting fav state for every chat
        this.chats.forEach(chat => { chat.isFavorite = false; });
        // marking favs as such
        this.myChats.favorites.forEach(id => {
            const favchat = this.chatMap[id];
            if (!favchat) {
                // fav chat isn't loaded, probably got favorited on another device
                this.addChat(id);
            } else {
                favchat.isFavorite = true;
            }
        });
        setTimeout(() => {
            // hiding all hidden chats
            this.myChats.hidden.forEach(id => {
                const chat = this.chatMap[id];
                if (chat) chat.hide();
            });
        }, 2000);
    }


    // initial fill chats list
    // Logic:
    // - load all favorite chats
    // - see if we have some limit left and load other unhidden chats
    // - see if digest contains some new chats that are not hidden
    // ORDER OF THE STEPS IS IMPORTANT ON MANY LEVELS
    @action async loadAllChats() {
        if (this.loaded || this.loading) return;
        this.loading = true;
        // 1. Loading my_chats keg
        this.myChats = new MyChats();
        this.myChats.onUpdated = this.applyMyChatsData;
        // 2. loading favorite chats
        // gonna happen in applyMyChatsData when fav list is loaded
        await asPromise(this.myChats, 'loaded', true);
        // 3. checking how many more chats we can load
        const rest = config.chat.maxInitalChats - this.myChats.favorites.length;
        if (rest > 0) {
            // 4. loading the rest unhidden chats
            await retryUntilSuccess(() =>
                socket.send('/auth/kegs/user/dbs')
                    .then(action(list => {
                        let k = 0;
                        for (const id of list) {
                            if (id === 'SELF' || this.myChats.hidden.includes(id)
                                || this.myChats.favorites.includes(id)) continue;
                            if (k++ >= rest) break;
                            this.addChat(id);
                        }
                    }))
            );
        }
        // 5. check if chats were created while we were loading chat list
        // unlikely, but possible
        Object.keys(tracker.digest).forEach(id => {
            this.addChat(id);
        });

        // 6. subscribe to future chats that will be created
        // this should always happen right after adding chats from digest, synchronously,
        // so that there's no new chats that can slip away
        tracker.onKegDbAdded(id => {
            // we do this with delay, because there's possibily of receiving this event
            // as a reaction to our own request to create a chat (no id yet so can't look it up in the map)
            // and while it's not an issue and is not going to break anything,
            // we still want to avoid wasting time on useless routine
            setTimeout(() => this.addChat(id), 2000);
        });
        // 7. waiting for most chats to load but up to a reasonable time
        await Promise.map(this.chats, chat => asPromise(chat, 'mostRecentMessageLoaded', true))
            .timeout(5000).catch(() => { /* well, the rest will trigger re-render */ });

        // 8. find out which chat to activate.
        const lastUsed = await TinyDb.user.getValue('lastUsedChat');
        if (lastUsed) this.activate(lastUsed);
        else if (this.chats.length) this.activate(this.chats[0].id);

        this.loading = false;
        this.loaded = true;
    }

    getSelflessParticipants(participants) {
        return participants.filter(p => !p.isMe);
    }

    findCachedChatWithParticipants(participants) {
        // validating participants
        if (!participants || !participants.length) {
            throw new Error('Can not start chat with no participants');
        }
        for (const p of participants) {
            if (p.loading || p.notFound) {
                throw new Error(`Invalid participant: ${p.username}, loading:${p.loading}, found:${!p.notFound}`);
            }
        }
        // we don't want our own user in participants, it's handled on the lowest level only.
        // generally ui should assume current user is participant to everything
        const filteredParticipants = this.getSelflessParticipants(participants);
        // maybe we already have this chat cached
        for (const c of this.chats) {
            if (c.hasSameParticipants(filteredParticipants)) return c;
        }
        return null;
    }
    //
    @action startChat(participants) {
        const cached = this.findCachedChatWithParticipants(participants);
        if (cached) {
            this.activate(cached.id);
            return cached;
        }
        const chat = new Chat(null, this.getSelflessParticipants(participants), this);
        chat.loadMetadata()
            .then(() => {
                this.addChat(chat.id, true);
                this.activate(chat.id);
            });
        return chat;
    }

    @action activate(id) {
        const chat = this.chatMap[id];
        if (!chat) return;
        TinyDb.user.setValue('lastUsedChat', id);
        if (this.activeChat) {
            tracker.deactivateKegDb(this.activeChat.id);
            this.activeChat.active = false;
        }
        tracker.activateKegDb(id);
        chat.active = true;
        this.activeChat = chat;
    }

    @action startChatAndShareFiles(participants, fileOrFiles) {
        const files = (Array.isArray(fileOrFiles) || isObservableArray(fileOrFiles)) ? fileOrFiles : [fileOrFiles];
        const chat = this.startChat(participants);
        return chat.loadMetadata().then(() => {
            chat.shareFiles(files);
            this.activate(chat.id);
        });
    }

    @action _unloadChat(chat) {
        if (chat.active) {
            if (this.chats.length > 1) {
                this.activate(this.chats.find(c => c.id !== chat.id).id);
            } else {
                this.activeChat = null;
            }
        }
        chat.dispose();
        chat.active = false;
        tracker.deactivateKegDb(chat.id);
        tracker.unregisterDbInstance(chat.id);

        delete this.chatMap[chat.id];
        this.chats.remove(chat);
    }

}

module.exports = new ChatStore();
