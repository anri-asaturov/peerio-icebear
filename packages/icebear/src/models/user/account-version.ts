import { observable } from 'mobx';
import SyncedKeg from '../kegs/synced-keg';

interface IAccountVersionPayload {
    migration: string;
}
interface IAccountVersionProps {
    accountVersion: number;
}
// TODO: need something more abstract here and in UI by the next migration

class AccountVersion extends SyncedKeg<IAccountVersionPayload, IAccountVersionProps> {
    constructor(user) {
        super('account_version', user.kegDb);
    }

    // current account version
    @observable accountVersion = 0;
    // migration specific data
    migration: { files?: string[] } = {};
    confirmed: boolean;

    serializeKegPayload() {
        return {
            migration: JSON.stringify(this.migration)
        };
    }

    deserializeKegPayload(data) {
        this.migration = JSON.parse(data.migration);
    }

    serializeProps() {
        return {
            accountVersion: this.accountVersion
        };
    }

    deserializeProps(data) {
        this.accountVersion = data.accountVersion;
    }

    __reset() {
        this.accountVersion = 0;
        this.migration = {};
        this.saveToServer();
    }
}

export default AccountVersion;