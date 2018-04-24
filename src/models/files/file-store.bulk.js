const { action, computed } = require('mobx');
const { getChatStore } = require('../../helpers/di-chat-store');
const volumeStore = require('../volumes/volume-store');
const config = require('../../config');
const warnings = require('../warnings');

/**
 * Extension to operate with selected files and folders in bulk
 */
class FileStoreBulk {
    // functor taking items selected as an argument to choose who to share with
    shareWithSelector = null;

    // functor taking folder as an argument to confirm folder deletion
    deleteFolderConfirmator = null;

    // functor taking files and shared fields as an argument to confirm
    // folder deletion
    deleteFolderConfirmator = null;

    // functor selecting folder for bulk download
    downloadFolderSelector = null;

    constructor(fileStore) {
        this.fileStore = fileStore;
    }

    @computed get canMove() {
        return !this.fileStore.selectedFilesOrFolders.some(f => f.isFolder && f.isShared);
    }

    async removeOne(i, batch) {
        if (i.isFolder && this.deleteFolderConfirmator) {
            if (!await this.deleteFolderConfirmator(i)) return;
        }
        if (i.isFolder && !i.isShared) {
            await this.fileStore.folders.deleteFolder(i);
            if (!batch) this.fileStore.folders.save();
        } else if (i.isFolder) {
            await volumeStore.deleteVolume(i);
        } else {
            await i.remove();
        }
    }

    @action.bound async remove() {
        const items = this.fileStore.selectedFilesOrFolders;
        if (this.deleteFilesConfirmator) {
            const files = items.filter(i => !i.isFolder);
            const sharedFiles = items.filter(i => i.shared);
            if (files.length && !await this.deleteFilesConfirmator(files, sharedFiles)) return;
        }
        let promise = Promise.resolve();
        items.forEach(i => {
            promise = promise.then(() => this.removeOne(i, true));
        });
        await promise;
        this.fileStore.folders.save();
        this.fileStore.clearSelection();
    }

    @action.bound async share() {
        if (!this.shareWithSelector) {
            console.error(`shareWithSelector has not been set`);
            return;
        }
        const items = this.fileStore.selectedFilesOrFolders;
        if (!items || !items.length) {
            console.log('no items selected');
            return;
        }
        const usernamesAccessList = await this.shareWithSelector();
        console.log(usernamesAccessList);
        if (!usernamesAccessList || !usernamesAccessList.length) {
            return;
        }
        let promise = Promise.resolve();
        items.forEach(i => {
            promise = promise.then(() => { i.selected = false; });
            if (i.isFolder) {
                promise = promise.then(
                    () => volumeStore.shareFolder(i, usernamesAccessList));
            } else {
                usernamesAccessList.forEach(contact => {
                    promise = promise.then(
                        async () => getChatStore().startChatAndShareFiles([contact], [i]));
                });
            }
        });
        await promise;
        this.fileStore.clearSelection();
    }

    @action.bound moveOne(item, folder, bulk) {
        item.selected = false;
        if (item.folderId === folder.folderId) return;
        if (item.isShared) return;
        folder.moveInto(item);
        if (!bulk) {
            if (folder.isShared) {
                warnings.add('title_itemMovedToFolder', null, { item: item.name, folder: folder.name });
            }
            this.fileStore.folders.save();
        }
    }

    @action.bound async move(targetFolder) {
        const items = this.fileStore.selectedFilesOrFolders;
        // currently progress is too quick, but in the future
        // it may make sense to show progress bar
        targetFolder.progress = 0;
        targetFolder.progressMax = items.length;
        // this is a mock to support async functions
        let promise = Promise.resolve();
        items.forEach(i => {
            promise = promise.then(async () => {
                // TODO: remove timeout
                await new Promise(resolve => setTimeout(resolve, 300));
                i.selected = false;
                if (i.folderId === targetFolder.folderId) return;
                if (i.isShared) return;
                targetFolder.moveInto(i);
                targetFolder.progress++;
            });
        });
        await promise;
        targetFolder.progress = null;
        targetFolder.progressMax = null;
        await this.fileStore.folders.save();
    }

    @action.bound async downloadOne(item, path) {
        item.selected = false;
        const downloadPath = await this.pickPathSelector(
            path,
            item.nameWithoutExtension || item.name,
            item.ext || '');
        // TODO: maybe run in parallel?
        if (item.isFolder) {
            await item.download(path, this.pickPathSelector, config.FileStream.createDir);
        } else {
            await item.download(downloadPath);
        }
    }

    @action.bound async download() {
        if (!this.downloadFolderSelector) {
            console.error(`downloadFolderSelector has not been set`);
            return;
        }
        if (!this.pickPathSelector) {
            console.error(`pickPathSelector has not been set`);
            return;
        }
        const path = await this.downloadFolderSelector();
        if (!path) return;
        const items = this.fileStore.selectedFilesOrFolders;
        let promise = Promise.resolve();
        items.forEach(item => {
            promise = promise.then(() => this.downloadOne(item, path));
        });
        await promise;
    }
}

module.exports = FileStoreBulk;