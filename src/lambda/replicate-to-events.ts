import '../init-lambda'

import { Tradle } from '../'

const { events, wrap } = new Tradle()
exports.handler = wrap(function* (event, context) {
  const results = events.fromStreamEvent(event)
  if (results.length) {
    yield events.putEvents(results)
  }
}, { source: 'dynamodbstreams' })
