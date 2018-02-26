const { observable, action, reaction, computed } = require('mobx');
const { getUser } = require('../../helpers/di-current-user');
const socket = require('../../network/socket');
const FileFolder = require('./file-folder');
const RootFolder = require('./root-folder');
const FileFoldersKeg = require('./file-folders-keg');
const cryptoUtil = require('../../crypto/util');
const warnings = require('../warnings');

const ROOT_FOLDER = new RootFolder();

class FileStoreFolders {
    constructor(fileStore) {
        this.fileStore = fileStore;
        socket.onceAuthenticated(() => {
            this.keg = new FileFoldersKeg(getUser().kegDb);
            this.keg.onUpdated = () => { this.sync(); };
        });
        reaction(() => this.currentFolder.isDeleted, deleted => {
            if (deleted) this.currentFolder = ROOT_FOLDER;
        });
    }

    @observable loaded = false;
    @observable keg = null;

    root = ROOT_FOLDER;
    @observable currentFolder = ROOT_FOLDER;

    folderResolveMap = observable.shallowMap({});
    folderIdReactions = {};

    getById(id) {
        return this.folderResolveMap.get(id);
    }

    _addFile = (file) => {
        const { root } = this;
        this.folderIdReactions[file.fileId] =
            reaction(() => file.folderId, folderId => {
                const folderToResolve = this.getById(folderId);
                if (file.folder && file.folder === folderToResolve) return;
                if (folderToResolve) {
                    file.folder && file.folder.free(file);
                    folderToResolve.add(file, true);
                } else {
                    !file.folder && root.add(file, true);
                }
            }, true);
    }

    _removeFile = (file) => {
        const { folder, fileId } = file;
        if (folder) folder.free(file);
        if (fileId && this.folderIdReactions[fileId]) {
            this.folderIdReactions[fileId]();
            delete this.folderIdReactions[fileId];
        }
    }

    @action sync() {
        const { files } = this.fileStore;
        if (this._intercept) {
            this._intercept();
            this._intercept = null;
        }
        const { folderResolveMap, root } = this;
        const newFolderResolveMap = {};
        root.deserialize(this.keg, null, folderResolveMap, newFolderResolveMap);
        // remove files from folders if they aren't present in the keg
        files.forEach(f => {
            if (f.folderId) {
                const folder = this.getById(f.folderId);
                if (folder) folder.moveInto(f);
            } else if (f.folder) f.folder.free(f);
        });
        // remove folders if they aren't present in the keg
        folderResolveMap.keys().forEach(folderId => {
            if (!newFolderResolveMap[folderId]) {
                folderResolveMap.get(folderId).freeSelf();
            }
        });
        Object.keys(newFolderResolveMap).forEach(folderId => {
            if (!folderResolveMap.has(folderId)) {
                folderResolveMap.set(folderId, newFolderResolveMap[folderId]);
            }
        });
        files.forEach(this._addFile);
        this._intercept = files.observe(delta => {
            delta.removed.forEach(this._removeFile);
            delta.added.forEach(this._addFile);
            return delta;
        });
        this.loaded = true;
    }

    @computed get folderResolveMapSorted() {
        return this.folderResolveMap.values()
            .sort((f1, f2) => f1.normalizedName > f2.normalizedName);
    }

    searchAllFoldersByName(name) {
        const q = name ? name.toLowerCase() : '';
        return this.folderResolveMapSorted
            .filter(f => f.normalizedName.includes(q));
    }

    selectedFolders() {
        return this.folderResolveMapSorted.filter(f => f.selected);
    }

    deleteFolder(folder) {
        folder.freeSelf();
        this.save();
    }

    createFolder(name, parent) {
        const target = parent || this.root;
        if (target.findFolderByName(name)) {
            warnings.addSevere('error_folderAlreadyExists');
            throw new Error('error_folderAlreadyExists');
        }
        const folder = new FileFolder(name);
        const folderId = cryptoUtil.getRandomShortIdHex();
        folder.folderId = folderId;
        folder.createdAt = Date.now();
        this.folderResolveMap.set(folderId, folder);
        target.addFolder(folder);
        return folder;
    }

    save() {
        this.keg.save(
            () => {
                this.keg.folders = this.root.folders.map(f => f.serialize());
                return true;
            },
            null,
            'error_savingFileFolders'
        ).catch(() => this.sync());
    }
}

module.exports = FileStoreFolders;
