import saveAccountKeyBackup from '~/helpers/pdf';
import { getTempFileName } from '../../e2e/code/helpers/files.js'; // TODO: create shared helpers folder

describe('PDF module', () => {
    it('generates account key backup file', () => {
        const dest = `${getTempFileName()}.pdf`;
        console.log('Saving pdf file', dest);
        return saveAccountKeyBackup(
            dest,
            'Firstname Lastname',
            'username',
            'abcd efgh ijkl mnop qrst uvwz abcd efgh'
        );
        // checking if the result is correct is a bit too much,
        // but this test is still useful since it can detect if pdf generation throws
        // and it allows manual inspection of the generated file
    });
});
