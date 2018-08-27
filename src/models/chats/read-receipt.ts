import { observable } from 'mobx';
import Keg from '../kegs/keg';

/**
 * Holds read position (kegId) for a user in a chat. Named keg, names contain usernames.
 * @param {string} username
 * @param {ChatKegDb} db
 * @extends {Keg}
 */
class ReadReceipt extends Keg {
    constructor(username, db) {
        super(username ? `read_receipt-${username}` : null, 'read_receipt', db, false, false, true);
    }
    /**
     * Id of the last read message
     */
    @observable chatPosition: number;
    /**
     * true if this receipt's name doesn't match keg owner.
     */
    receiptError: boolean;

    serializeKegPayload() {
        return { chatPosition: +this.chatPosition };
    }

    deserializeKegPayload(payload) {
        this.chatPosition = +(payload.chatPosition || 0);
    }

    afterLoad() {
        this.receiptError = !this.id.endsWith(`-${this.owner}`);
    }
}

export default ReadReceipt;
