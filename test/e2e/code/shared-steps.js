const { defineSupportCode } = require('cucumber');
const { getRandomUsername } = require('./helpers/random-data');
const testConfig = require('./test-config');

defineSupportCode(({ Given, When, Then }) => {
    Given('I create an account', async function() {
        await this.libs.prombservable.asPromise(this.ice.socket, 'connected', true);

        const u = new this.ice.User();
        u.username = getRandomUsername();
        u.email = `${u.username}@${testConfig.emailDomain}`;
        u.firstName = 'Firstname';
        u.lastName = 'Lastname';
        u.locale = 'en';
        u.passphrase = testConfig.defaultPassphrase;
        this.ice.User.current = u;
        this.username = u.username;
        this.passphrase = u.passphrase;
        console.log(`creating user username: ${this.username} passphrase: ${this.passphrase}`);

        await u.createAccountAndLogin();
        return this.waitForAccountDataInit();
    });

    When('I login', function() {
        return this.login();
    });

    Then('I am authenticated', function() {
        expect(this.ice.socket.authenticated).to.be.true;
    });

    Then('I am not authenticated', function() {
        expect(this.ice.socket.authenticated).to.be.false;
    });

    When('I restart', function() {
        return this.app.restart();
    });
});
