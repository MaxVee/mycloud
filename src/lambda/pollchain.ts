import '../init-lambda'

const { debug, wrap, seals } = require('../').tradle
exports.handler = wrap(function (event, context) {
  debug('[START]', Date.now())
  return seals.syncUnconfirmed()
}, { source: 'schedule' })
