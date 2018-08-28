/* eslint-disable no-unused-vars */
import { AbstractCallError } from '../../errors';

/**
 * Abstract File Stream class. Icebear wants to read/write files,
 * but doesn't know how exactly that would work on your platform.
 *
 * 1. create you own class and inherit from FileStreamAbstract.
 * 2. override required functions.
 * 3. set config.FileStream = YourFileStreamImplementation.
 * @param filePath - will be used by 'open' function
 * @param mode - 'read' or 'write' or 'append'
 */
class FileStreamAbstract {
    constructor(filePath: string, mode: 'read' | 'write' | 'append') {
        this.filePath = filePath;
        if (mode !== 'read' && mode !== 'write' && mode !== 'append') {
            throw new Error('Invalid stream mode.');
        }
        this.mode = mode;
        this.pos = 0;
    }

    filePath: string;
    mode: string;
    /**
     * File stream pointer
     */
    pos: number;

    /**
     * Reads a chunk of data from file stream.
     * @param size - amount of bytes to read (if possible)
     * @return resolves with a number of bytes written to buffer
     */
    read = (size: number) => {
        if (this.mode !== 'read') {
            return Promise.reject(new Error('Attempt to read from write stream.'));
        }
        return this.readInternal(size).then(this._increasePosition);
    };

    _increasePosition = buf => {
        this.pos += buf.length;
        return buf;
    };

    /**
     * Override this in your implementation.
     * @param size - bytes
     */
    readInternal(size: number): Promise<Uint8Array> {
        throw new AbstractCallError();
    }

    /**
     * Writes a chunk of data to file stream
     * @returns Promise resolves when chunk is written out
     */
    write = (buffer: Uint8Array) => {
        if (this.mode !== 'write' && this.mode !== 'append') {
            return Promise.reject(
                new Error(`file-stream.js: Attempt to write to read stream. ${this.mode}`)
            );
        }
        this._increasePosition(buffer);
        if (!buffer || !buffer.length) return Promise.resolve();
        return this.writeInternal(buffer).then(this._increasePosition);
    };

    /**
     * Override this in your implementation.
     * @returns buffer, same one as was passed
     */
    writeInternal(buffer: Uint8Array): Promise<Uint8Array> {
        throw new AbstractCallError();
    }

    /**
     * Move file position pointer.
     * @returns new position
     */
    seek = (pos: number): number => {
        if (this.mode !== 'read') throw new Error('Seek only on read streams');
        return this.seekInternal(pos);
    };

    /**
     * Override this in your implementation. Move file position pointer.
     * @returns new position
     */
    seekInternal(pos: number): number {
        throw new AbstractCallError();
    }

    /**
     * Override. This function has to set 'size' property.
     */
    open(): Promise<FileStreamAbstract> {
        throw new AbstractCallError();
    }

    /**
     * Override. Called when done working with file, should flush all buffers and dispose resources.
     */
    close() {
        throw new AbstractCallError();
    }

    /**
     * Override. Returns full path for file when there's a default cache path implemented in the app.
     * Currently only mobile.
     * @param uid - unique identifier
     * @param name - human-readable file name
     * @returns actual device path for file
     */
    static getFullPath(uid: string, name: string): string {
        throw new AbstractCallError();
    }

    /**
     * Override.
     * @returns true if path exists on device
     */
    static exists(path: string): boolean {
        throw new AbstractCallError();
    }

    /**
     * Override. Launch external viewer.
     * @param path - file path to open in a viewer.
     */
    static launchViewer(path: string) {
        throw new AbstractCallError();
    }

    /**
     * Override. Get file stat object.
     */
    static getStat(path: string): Promise<{ size: number }> {
        throw new AbstractCallError();
    }

    /**
     * Override. Currently mobile only.
     * @returns array of absolute paths to cached items.
     */
    static getCacheList(): Promise<string[]> {
        throw new AbstractCallError();
    }

    /**
     * Override. Removes file by path.
     */
    static delete(path: string): Promise {
        throw new AbstractCallError();
    }

    /**
     * Override. Renames old path to new path.
     */
    static rename(oldPath: string, newPath: string): Promise {
        throw new AbstractCallError();
    }

    /**
     * Override. Returns a path for storing temporarily downloaded(cached) files.
     */
    static getTempCachePath(name: string) {
        throw new AbstractCallError();
    }

    /**
     * Override. Creates a directory at "path".
     */
    static createDir(path: string) {
        throw new AbstractCallError();
    }

    /**
     * Override. Empties and them removes a directory at "path".
     */
    static removeDir(path: string) {
        throw new AbstractCallError();
    }
}

export default FileStreamAbstract;
