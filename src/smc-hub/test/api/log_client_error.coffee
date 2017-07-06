###
API test of log_client_error
###

api   = require('./apitest')
{setup, teardown} = api

misc = require('smc-util/misc')

expect = require('expect')


describe 'log_client_error', ->
    before(setup)
    after(teardown)

    logged_event = 'error'
    logged_error = 'API error FOO'

    it "logs an error", ->
        api.call
            event : 'log_client_error'
            body  :
                error   : logged_error
            cb    : ->
    it 'gets error log using database', (done) ->
        api.db.get_client_error_log
            event : logged_event
            cb    : (err, log) ->
                expect(log.length).toBe(1)
                expect(log[0]).toEqual
                    event:logged_event
                    error:logged_error
                    account_id:api.account_id
                    id:log[0].id
                    time:log[0].time
                done(err)
