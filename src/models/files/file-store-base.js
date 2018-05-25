const { observable, action, computed } = require('mobx');
const socket = require('../../network/socket');
const File = require('./file');
const tracker = require('../update-tracker');
const _ = require('lodash');
const { retryUntilSuccess } = require('../../helpers/retry');
const createMap = require('../../helpers/dynamic-array-map');
const FileStoreFolders = require('./file-store.folders');
const { getUser } = require('../../helpers/di-current-user');
const { getRandomShortIdHex } = require('../../crypto/util.random');
const { getFileStore } = require('../../helpers/di-file-store');

class FileStoreBase {
    static instances = observable.map();

    constructor(kegDb, root = null, id) {
        this.id = id || getRandomShortIdHex(); // something to identify this instance in runtime
        this._kegDb = kegDb;
        const m = createMap(this.files, 'fileId');
        this.fileMap = m.map;
        this.fileMapObservable = m.observableMap;
        this.folderStore = new FileStoreFolders(this, root);
        if (id !== 'main') FileStoreBase.instances.set(this.id, this);

        tracker.subscribeToKegUpdates(kegDb ? kegDb.id : 'SELF', 'file', () => {
            console.log('Files update event received');
            this.onFileDigestUpdate();
        });
    }
    getFileStoreById(id) {
        if (id === 'main') return getFileStore();
        return FileStoreBase.instances.get(id);
    }

    getFileStoreInstances() {
        return FileStoreBase.instances;
    }
    dispose() {
        FileStoreBase.instances.delete(this.id);
    }

    get kegDb() {
        return this._kegDb || getUser().kegDb;
    }

    // Full list of user's files in SELF.
    @observable.shallow files = [];

    // all files currently loaded in RAM, including volumes, excluding chats
    @computed get allFiles() {
        let ret = this.files;
        if (this.isMainStore) {
            FileStoreBase.instances.forEach(store => { ret = ret.concat(store.files.slice()); });
        }
        return ret;
    }

    // Subset of files not currently hidden by any applied filters
    @computed get visibleFiles() {
        return this.allFiles.filter(f => f.show);
    }

    // Subset of files and folders not currently hidden by any applied filters
    @computed get visibleFilesAndFolders() {
        return this.visibleFolders.concat(this.visibleFiles);
    }

    // Filter to apply when computing visible folders
    @observable folderFilter = '';

    // Subset of folders not currently hidden by any applied filters
    @computed get visibleFolders() {
        return this.folderStore.searchAllFoldersByName(this.folderFilter);
    }

    // Store is loading full file list for the first time.
    @observable loading = false;
    // Will set to true after file list has been updated upon reconnect.
    @observable updatedAfterReconnect = true;
    // Readonly, shows which keyword was used with last call to `filter()`, this need refactoring.
    @observable currentFilter = '';
    // Initial file list was loaded.
    @observable loaded = false;
    // Updates to file store are paused.
    @observable paused = false;
    // Currently updating file list from server, this is not observable property.
    updating = false;

    maxUpdateId = '';
    knownUpdateId = '';

    // optimization to avoid creating functions every time
    static isFileSelected(file) {
        return file.selected;
    }

    // optimization to avoid creating functions every time
    static isSelectedFileShareable(file) {
        return !file.selected ? true : file.canShare;
    }

    // optimization to avoid creating functions every time
    static isFileShareable(file) {
        return file.canShare;
    }

    @computed get hasSelectedFiles() {
        return this.allFiles.some(FileStoreBase.isFileSelected);
    }

    @computed get hasSelectedFilesOrFolders() {
        return this.selectedFilesOrFolders.length;
    }

    @computed get canShareSelectedFiles() {
        return this.hasSelectedFiles && this.allFiles.every(FileStoreBase.isSelectedFileShareable);
    }

    @computed get allVisibleSelected() {
        for (let i = 0; i < this.allFiles.length; i++) {
            if (!this.allFiles[i].show) continue;
            if (this.allFiles[i].selected === false) return false;
        }
        return true;
    }

    @computed get selectedCount() {
        return this.selectedFiles.length;
    }

    getFilesSharedBy(username) {
        return this.files.filter(f => f.owner === username);
    }
    // Returns currently selected files (file.selected == true)
    @computed get selectedFiles() {
        return this.allFiles.filter(FileStoreBase.isFileSelected);
    }

    // Returns currently selected files that are also shareable.
    getShareableSelectedFiles() {
        return this.allFiles.filter(FileStoreBase.isFileSelectedAndShareable);
    }

    // Returns currently selected folders (folder.selected == true)
    get selectedFolders() {
        return getFileStore().folderStore.selectedFolders;
    }

    @computed get selectedFilesOrFolders() {
        return this.selectedFolders.concat(this.selectedFiles);
    }

    // Deselects all files and folders
    @action clearSelection() {
        this.selectedFilesOrFolders.forEach(f => { f.selected = false; });
    }

    // Deselects unshareable files
    @action deselectUnshareableFiles() {
        this.selectedFilesOrFolders.forEach(f => {
            if (f.canShare) return;
            f.selected = false;
        });
    }

    // Applies filter to files.
    @action filterByName(query) {
        this.currentFilter = query;
        const regex = new RegExp(_.escapeRegExp(query), 'i');
        for (let i = 0; i < this.allFiles.length; i++) {
            const f = this.allFiles[i];
            f.show = regex.test(f.name);
            if (!f.show) f.selected = false;
        }
    }

    // Resets filter
    @action clearFilter() {
        this.currentFilter = '';
        for (let i = 0; i < this.files.length; i++) {
            this.files[i].show = true;
        }
        if (this.isMainStore) {
            FileStoreBase.instances.forEach(store => store.clearFilter());
        }
    }

    onFileDigestUpdate = _.debounce(() => {
        if (this.paused) return;

        const digest = tracker.getDigest(this.kegDb.id, 'file');
        // this.unreadFiles = digest.newKegsCount;
        if (this.loaded && digest.maxUpdateId === this.maxUpdateId) {
            this.updatedAfterReconnect = true;
            return;
        }
        this.maxUpdateId = digest.maxUpdateId;
        this.updateFiles();
    }, 2000, { leading: true, maxWait: 4000 });

    _getFiles() {
        const filter = this.knownUpdateId ? { minCollectionVersion: this.knownUpdateId } : {};
        // this is naturally paged because every update calls another update in the end
        // until all update pages are loaded
        return socket.send('/auth/kegs/db/list-ext', {
            kegDbId: this.kegDb.id,
            options: {
                type: 'file',
                reverse: false,
                count: 50
            },
            filter
        }, false);
    }

    @action _loadPage(fromKegId) {
        return retryUntilSuccess(
            () => socket.send('/auth/kegs/db/list-ext', {
                kegDbId: this.kegDb.id,
                options: {
                    type: 'file',
                    reverse: false,
                    fromKegId,
                    count: 50
                },
                filter: {
                    deleted: false,
                    hidden: false
                }
            }, false),
            `Initial file list loading for ${this.kegDb.id}`
        ).then(action(kegs => {
            for (const keg of kegs.kegs) {
                if (keg.deleted || keg.hidden) {
                    console.log('Hidden or deleted file kegs should not have been returned by server.', keg);
                    continue;
                }
                const file = new File(this.kegDb, this);
                if (keg.collectionVersion > this.maxUpdateId) {
                    this.maxUpdateId = keg.collectionVersion;
                }
                if (keg.collectionVersion > this.knownUpdateId) {
                    this.knownUpdateId = keg.collectionVersion;
                }
                if (file.loadFromKeg(keg)) {
                    if (!file.fileId) {
                        if (file.version > 1) console.error('File keg missing fileId', file.id);
                        // we can get a freshly created keg, it's not a big deal
                        continue;
                    }
                    if (this.fileMap[file.fileId]) {
                        console.error('File keg has duplicate fileId', file.id);
                        continue;
                    }
                    this.files.unshift(file);
                    if (!this.loaded && this.onInitialFileAdded) {
                        this.onInitialFileAdded(keg, file);
                    }
                } else {
                    console.error('Failed to load file keg.', keg.kegId);
                    // trying to be safe performing destructive operation of deleting a corrupted file keg
                    // (old file system had some)
                    if (keg.decryptionError && keg.type === 'file' && !keg.format) {
                        console.log('Removing invalid file keg', keg);
                        file.remove();
                    }
                    continue;
                }
            }
            const size = kegs.kegs.length;
            return { size, maxId: size > 0 ? kegs.kegs[0].kegId : 0 };
        }));
    }

    @action _finishLoading() {
        this.loading = false;
        this.loaded = true;
        socket.onDisconnect(() => { this.updatedAfterReconnect = false; });
        tracker.onUpdated(this.onFileDigestUpdate);
        setTimeout(this.onFileDigestUpdate);
        tracker.seenThis(this.kegDb.id, 'file', this.knownUpdateId);
    }

    /**
     * Call at least once from UI.
     * @public
     */
    loadAllFiles = async () => {
        if (this.loading || this.loaded) return;
        this.loading = true;
        let lastPage = { maxId: '999' };
        do {
            lastPage = await this._loadPage(lastPage.maxId); // eslint-disable-line no-await-in-loop
        } while (lastPage.size > 0);
        this._finishLoading();
    };

    // this essentially does the same as loadAllFiles but with filter,
    // we reserve this way of updating anyway for future, when we'll not gonna load entire file list on start
    updateFiles = () => {
        if (!this.loaded || this.updating || this.knownUpdateId === this.maxUpdateId) return;
        const maxId = this.maxUpdateId; // eslint-disable-line
        console.log(`Proceeding to file update. Known collection version: ${this.knownUpdateId}`);
        this.updating = true;
        let dirty = false;
        retryUntilSuccess(() => this._getFiles(), `Updating file list for ${this.kegDb.id}`)
            .then(action(resp => {
                const { kegs } = resp;
                for (const keg of kegs) {
                    if (keg.collectionVersion > this.knownUpdateId) {
                        this.knownUpdateId = keg.collectionVersion;
                    }
                    if (!keg.props.fileId && !keg.deleted) {
                        console.error('File keg missing fileId', keg.kegId);
                        continue;
                    }
                    const existing = this.getById(keg.props.fileId) || this.getByKegId(keg.kegId);
                    const file = existing || new File(this.kegDb, this);
                    if (keg.deleted || keg.hidden) {
                        if (existing) this.files.remove(existing);
                        continue;
                    }
                    if (!file.loadFromKeg(keg) || file.isEmpty) continue;
                    if (!existing) {
                        dirty = true;
                        this.files.unshift(file);
                    }
                }
                this.updating = false;
                // need this because if u delete all files knownUpdateId won't be set at all after initial load
                if (this.knownUpdateId < maxId) this.knownUpdateId = maxId;
                // in case we missed another event while updating
                setTimeout(this.onFileDigestUpdate);

                this.updatedAfterReconnect = true;
                tracker.seenThis(this.kegDb.id, 'file', this.knownUpdateId);
                if (this.onAfterUpdate) {
                    this.onAfterUpdate(dirty);
                }
            }));
    };

    /**
     * Finds file in user's drive by fileId.
     * Looks for loaded files only (all of them are loaded normally)
     * @param {string} fileId
     * @returns {?File}
     */
    getById(fileId) {
        return this.fileMapObservable.get(fileId);
    }
    /**
     * Finds file in user's drive by kegId. This is not used often,
     * only to detect deleted descriptor and remove file from memory,
     * since deleted keg has no props to link it to the file.
     * Looks for loaded files only (all of them are loaded normally)
     * @param {string} kegId
     * @returns {?File}
     */
    getByKegId(kegId) {
        return this.files.find(f => f.id === kegId);
    }

    /**
     * Pause file store updates.
     * @public
     */
    pause() {
        this.paused = true;
    }

    /**
     * Resume file store updates.
     * @public
     */
    resume() {
        if (!this.paused) return;
        this.paused = false;
        setTimeout(() => {
            this.onFileDigestUpdate();
        });
    }
}

module.exports = FileStoreBase;