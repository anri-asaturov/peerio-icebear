Feature: User profile
 Scenario: Add avatar with wrong number of pictures
        Given I am logged in
        When the upload does not contain 2 blobs
        Then I should get an error saying Blobs array length should be 2