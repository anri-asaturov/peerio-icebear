Feature: 2 factor authentication
    As a user
    In order to have extra security
    I want to have 2 factor authentication

    Background:
        Given I am logged in

    Scenario: Enable 2FA
        When I enable 2FA
        Then I should receive a confirmation

    Scenario: Try to enable 2FA when it's already active
        When I enable 2FA
        But 2FA is already enabled
        Then I should receive an error saying "2fa already enabled on this account."

    Scenario: Disable 2FA
        Given 2FA is enabled
        When I disable 2FA
        Then I should receive a confirmation

# todo:        
# Sign in with backup code
# Sign in with 2FA code
# Regenerate backup codes
# Trust device   