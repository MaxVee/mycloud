const co = require('co').wrap
const { errors, constants, utils } = require('../../')
const { extend } = utils
const { getter } = require('../utils')
const fakeSeals = require('./seals')
const promiseNoop = co(function* () {})

module.exports = function fakeTradle ({ objects, identities, messages, send }) {
  const seals = {}
  const inbox = {}
  const outbox = {}
  return {
    errors,
    constants,
    tables: {},
    seals: fakeSeals({
      seals
    }),
    objects: {
      getObjectByLink: getter(objects),
    },
    identities: {
      getIdentityByPermalink: getter(identities)
    },
    messages: {
      // getMessagesFrom,
      // getMessagesTo
    },
    provider: {
      sendMessage: co(function* ({ to, object, other={} }) {
        if (!outbox[to]) outbox[to] = []

        outbox[to].push({
          author: 'bot',
          link: 'abc',
          permalink: 'abc',
          object: extend({
            recipientPubKey: {}
          }, other)
        })

        yield send(...arguments)
      }),
      getMyChainKey: promiseNoop
    }
  }
}
