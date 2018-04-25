const { observable, action, computed } = require('mobx');
const socket = require('../../network/socket');
const File = require('./file');
const tracker = require('../update-tracker');
const config = require('../../config');
const util = require('../../util');
const _ = require('lodash');
const { retryUntilSuccess } = require('../../helpers/retry');
const createMap = require('../../helpers/dynamic-array-map');
const FileStoreFolders = require('./file-store.folders');
const FileStoreBulk = require('./file-store.bulk');
const { getUser } = require('../../helpers/di-current-user');

class FileStoreBase {
    static instances = [];

    constructor(kegDb) {
        FileStoreBase.instances.push(this);
        this._kegDb = kegDb;
        const m = createMap(this.files, 'fileId');
        this.fileMap = m.map;
        this.fileMapObservable = m.observableMap;
        this.folders = new FileStoreFolders(this);
        this.bulk = new FileStoreBulk(this);

        tracker.subscribeToKegUpdates(kegDb ? kegDb.id : 'SELF', 'file', () => {
            console.log('Files update event received');
            this.onFileDigestUpdate();
        });
    }

    dispose() {
        const ind = FileStoreBase.instances.indexOf(this);
        if (ind < 0) return;
        FileStoreBase.instances.splice(ind, 1);
    }

    get kegDb() {
        return this._kegDb || getUser().kegDb;
    }

    // Full list of user's files.
    @observable.shallow files = [];

    // Subset of files not currently hidden by any applied filters
    @computed get visibleFiles() {
        return this.files.filter(f => f.show);
    }

    // Subset of files and folders not currently hidden by any applied filters
    @computed get visibleFilesAndFolders() {
        const folders = this.folders.searchAllFoldersByName(this.currentFilter);
        return folders.concat(this.files.filter(f => f.show));
    }

    // Filter to apply when computing visible folders
    @observable folderFilter = '';

    // Subset of folders not currently hidden by any applied filters
    @computed get visibleFolders() {
        return this.folders.searchAllFoldersByName(this.folderFilter);
    }

    // Human readable maximum auto-expandable inline image size limit
    inlineImageSizeLimitFormatted = util.formatBytes(config.chat.inlineImageSizeLimit);
    // Human readable maximum cutoff inline image size limit
    inlineImageSizeLimitCutoffFormatted = util.formatBytes(config.chat.inlineImageSizeLimitCutoff);

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
        return this.files.some(FileStoreBase.isFileSelected);
    }

    @computed get hasSelectedFilesOrFolders() {
        return this.selectedFilesOrFolders.length;
    }

    @computed get canShareSelectedFiles() {
        return this.hasSelectedFiles && this.files.every(FileStoreBase.isSelectedFileShareable);
    }

    @computed get allVisibleSelected() {
        for (let i = 0; i < this.files.length; i++) {
            if (!this.files[i].show) continue;
            if (this.files[i].selected === false) return false;
        }
        return true;
    }

    @computed get selectedCount() {
        let ret = 0;
        for (let i = 0; i < this.files.length; i++) {
            if (this.files[i].selected) ret += 1;
        }
        return ret;
    }

    // Returns currently selected files (file.selected == true)
    getSelectedFiles() {
        return this.files.filter(FileStoreBase.isFileSelected);
    }

    // Returns currently selected files that are also shareable.
    getShareableSelectedFiles() {
        return this.files.filter(FileStoreBase.isFileSelectedAndShareable);
    }

    // Returns currently selected folders (folder.selected == true)
    get selectedFolders() {
        return this.folders.selectedFolders;
    }

    @computed get selectedFilesOrFolders() {
        return this.selectedFolders.slice().concat(this.getSelectedFiles());
    }

    // Deselects all files and folders

    @action clearSelection() {
        for (let i = 0; i < this.files.length; i++) {
            this.files[i].selected = false;
        }
        // selectedFolders is computable, do not recalculate it
        const selFolders = this.selectedFolders;
        for (let i = 0; i < selFolders.length; i++) {
            selFolders[i].selected = false;
        }
    }

    // Selects all files
    @action selectAll() {
        for (let i = 0; i < this.files.length; i++) {
            const file = this.files[i];
            if (!file.show || !file.readyForDownload) continue;
            this.files[i].selected = true;
        }
    }

    // Deselects unshareable files
    @action deselectUnshareableFiles() {
        for (let i = 0; i < this.files.length; i++) {
            const file = this.files[i];
            if (file.canShare) continue;
            if (file.selected) file.selected = false;
        }
    }

    // Applies filter to files.
    @action filterByName(query) {
        this.currentFilter = query;
        const regex = new RegExp(_.escapeRegExp(query), 'i');
        for (let i = 0; i < this.files.length; i++) {
            this.files[i].show = regex.test(this.files[i].name);
            if (!this.files[i].show) this.files[i].selected = false;
        }
    }

    // Resets filter
    @action clearFilter() {
        this.currentFilter = '';
        for (let i = 0; i < this.files.length; i++) {
            this.files[i].show = true;
        }
    }

    onFileDigestUpdate = _.throttle(() => {
        if (this.paused) return;

        const digest = tracker.getDigest(this.kegDb.id, 'file');
        // this.unreadFiles = digest.newKegsCount;
        if (this.loaded && digest.maxUpdateId === this.maxUpdateId) {
            this.updatedAfterReconnect = true;
            return;
        }
        this.maxUpdateId = digest.maxUpdateId;
        this.updateFiles(this.maxUpdateId);
    }, 1500);

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
                    console.log('Hidden or deleted file kegs should not have been returned by server. kegid:', keg.id);
                    continue;
                }
                const file = new File(this.kegDb);
                if (keg.collectionVersion > this.maxUpdateId) {
                    this.maxUpdateId = keg.collectionVersion;
                }
                if (keg.collectionVersion > this.knownUpdateId) {
                    this.knownUpdateId = keg.collectionVersion;
                }
                if (file.loadFromKeg(keg)) {
                    if (!file.fileId) {
                        console.error('File keg missing fileId', file.id);
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
                    // if (keg.version > 1 && keg.type === 'file'
                    //     && (!keg.createdAt || Date.now() - keg.createdAt > 600000000/* approx 1 week */)) {
                    //     console.log('Removing invalid file keg', keg);
                    //     file.remove();
                    // }
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
        setTimeout(this.updateFiles);
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
    updateFiles = (maxId) => {
        if (!this.loaded || this.updating) return;
        if (!maxId) maxId = this.maxUpdateId; // eslint-disable-line
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
                    const file = existing || new File(this.kegDb);
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
                if (kegs.length || (this.maxUpdateId && this.knownUpdateId < this.maxUpdateId)) {
                    setTimeout(this.updateFiles);
                } else {
                    setTimeout(this.onFileDigestUpdate);
                }
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
