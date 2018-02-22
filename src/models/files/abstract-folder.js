const { observable, computed } = require('mobx');
const util = require('../../util');

class AbstractFolder {
    @observable.shallow files = [];
    @observable.shallow folders = [];
    @observable name;
    @observable createdAt;
    @observable isDeleted;

    @computed get normalizedName() {
        return this.name ? this.name.toLowerCase() : '';
    }

    @computed get foldersSortedByName() {
        return this.folders.sort((f1, f2) => f1.normalizedName > f2.normalizedName);
    }

    @computed get filesSortedByDate() {
        return this.files.sort((f1, f2) => f2.uploadedAt - f1.uploadedAt);
    }

    @computed get foldersAndFilesDefaultSorting() {
        const { foldersSortedByName, filesSortedByDate } = this;
        return foldersSortedByName.concat(filesSortedByDate);
    }

    @computed get size() {
        let currentSize = 0;
        for (const folder of this.folders) {
            currentSize += folder.size;
        }
        for (const file of this.files) {
            currentSize += file.size;
        }
        return currentSize;
    }

    @computed get sizeFormatted() {
        return util.formatBytes(this.size);
    }

    get hasNested() {
        return this.folders && this.folders.length;
    }

    findFolderByName(name) {
        const normalizedName = name.toLowerCase();
        return this.folders.find(f => f.normalizedName === normalizedName);
    }

    add(/* file, skipSaving */) {
        throw new Error('add is not implemented');
    }

    addFolder(/* folder */) {
        throw new Error('addFolder is not implemented');
    }

    free(/* file */) {
        throw new Error('free is not implemented');
    }

    freeFolder(/* folder */) {
        throw new Error('freeFolder is not implemented');
    }

    freeSelf() {
        throw new Error('freeFolder is not implemented');
    }

    moveInto(/* file */) {
        throw new Error('moveInto is not implemented');
    }

    rename(/* name */) {
        throw new Error('rename is not implemented');
    }
}

module.exports = AbstractFolder;
