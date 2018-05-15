const { Then, When } = require('cucumber');
const { getRandomUsername, getRandomEmail } = require('../helpers/random-data');

async function findContact(query) {
    const contact = this.ice.contactStore.getContact(query);
    await this.waitFor(() => contact.loading === false, 5000);
    contact.notFound.should.be.false;
    return contact;
}

Then('I can not find unregistered account by random username', function() {
    const username = getRandomUsername();
    const contact = this.ice.contactStore.getContact(username);
    return this.waitFor(() => contact.notFound === true, 5000);
});

Then('I can find the test account by email', async function() {
    const contact = await findContact.call(this, this.testAccount.email);
    contact.username.should.equal(this.testAccount.username);
});

Then('I can find the test account by username', async function() {
    const contact = await findContact.call(this, this.testAccount.username);
    contact.addresses[0].should.equal(this.testAccount.email);
});

Then('test account is not added to my contacts', function() {
    expect(this.ice.contactStore
        .contacts.find(c => c.username === this.testAccount.username))
        .to.be.undefined;
});

When('I favorite the test account', function() {
    return this.ice.contactStore.addContact(this.testAccount.username);
});

When('I unfavorite the test account', function() {
    return this.ice.contactStore.removeContact(this.testAccount.username);
});

When('the test account is my favorite contact', function() {
    const c = this.ice.contactStore.getContact(this.testAccount.username);
    c.isAdded.should.be.true;
});

When('the test account is not my favorite contact', function() {
    const c = this.ice.contactStore.getContact(this.testAccount.username);
    c.isAdded.should.be.false;
});

When('I invite random email', function() {
    this.invitedEmail = getRandomEmail();
    return this.ice.contactStore.invite(this.invitedEmail);
});

When('I create a test account with invited email', function() {
    return this.createTestAccount(null, this.invitedEmail);
});

Then('the invite is converted to pending dm', async function() {
    const c = this.ice.contactStore.getContact(this.invitedEmail);
    await this.waitFor(() => !c.loading, 5000);
    expect(!!this.ice.chatStore.directMessages.find(
        chat => chat.isInvite && chat.username === c.username)).to.be.true;
});

When('I delete invited random email', function() {
    return this.ice.contactStore.removeInvite(this.invitedEmail);
});

Then('I don\'t have pending dm', async function() {
    const c = this.ice.contactStore.getContact(this.invitedEmail);
    await this.waitFor(() => !c.loading, 5000);
    expect(!!this.ice.chatStore.directMessages.find(
        chat => chat.isInvite && chat.username === c.username)).to.be.false;
});
