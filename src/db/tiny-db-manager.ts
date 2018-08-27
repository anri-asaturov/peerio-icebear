import TinyDbCollection from './tiny-db-collection';

/**
 * TinyDbManager manages system and user collections, and allows opening
 * other collections.
 * @param {Function} [createStorageEngine] - function returning a new storage engine for the name
 */
class TinyDbManager {
    constructor(createStorageEngine) {
        this.createStorageEngine = createStorageEngine;
        this.systemCollection = null;
        this.userCollection = null;
    }

    /**
     * Instance of unencrypted system collection.
     */
    get system(): TinyDbCollection {
        if (!this.systemCollection) this.openSystem();
        return this.systemCollection;
    }

    /**
     * Instance of encrypted user collection.
     * Only values are encrypted.
     */
    get user(): TinyDb {
        return this.userCollection;
    }

    /**
     * Creates a collection instance.
     * @param {string} name - database name
     * @param {Uint8Array} [encryptionKey] - optional encryption key
     * @returns {TinyDbCollection}
     */
    open(name, encryptionKey) {
        const engine = this.createStorageEngine(name);
        return new TinyDbCollection(engine, name, encryptionKey);
    }

    /**
     * Creates system collection instance and assigns it to {@link system} property
     * @returns {TinyDbCollection} system collection
     */
    openSystem() {
        this.systemCollection = this.open('$system$');
        return this.systemCollection;
    }

    /**
     * Creates user collection instance and assigns it to {@link user} property
     * @param {string} username
     * @param {Uint8Array} encryptionKey - database key
     * @returns {TinyDbCollection} user collection
     */
    openUser(username, encryptionKey) {
        this.userCollection = this.open(username, encryptionKey);
        return this.userCollection;
    }
}

export default TinyDbManager;
