
const debug = require('debug')('tradle:sls:iot')
const aws = require('./aws')
const { co, clone } = require('./utils')
const { IOT_TOPIC_PREFIX='' } = require('./env')
const DEFAULT_QOS = 1

function publish (params) {
  params = clone(params)
  if (!('qos' in params)) params.qos = DEFAULT_QOS

  if (typeof params.payload === 'object') {
    params.payload = JSON.stringify(params.payload)
  }

  params.topic = prefixTopic(params.topic)
  debug(`publishing to ${params.topic}: ${JSON.stringify(params)}`)
  return aws.iotData.publish(params).promise()
}

function sendMessages ({ clientId, payload }) {
  return publish({
    topic: getMessagesTopicForClient(clientId),
    payload
  })
}

function prefixTopic (topic) {
  return `${IOT_TOPIC_PREFIX}${topic}`
}

function unprefixTopic (topic) {
  return topic.slice(IOT_TOPIC_PREFIX.length)
}

function getMessagesTopicForClient (clientId) {
  return `${clientId}/message`
}

function includesClientMessagesTopic ({ clientId, topics }) {
  const catchAllTopic = `${clientId}/*`
  const messagesTopic = getMessagesTopicForClient(clientId)
  return topics
    .map(unprefixTopic)
    .find(topic => {
      return topic === messagesTopic || topic === catchAllTopic
    })
}

// function sendChallenge ({ clientId, challenge }) {
//   return publish({
//     topic: `${clientId}/challenge`,
//     payload: challenge
//   })
// }

// function sendAuthenticated ({ clientId }) {
//   return publish({
//     topic: `${clientId}/authenticated`
//   })
// }

const getEndpoint = co(function* () {
  const { endpointAddress } = yield aws.iot.describeEndpoint().promise()
  return endpointAddress
})

// function getRegionFromEndpoint (iotEndpoint) {
//   const partial = iotEndpoint.replace('.amazonaws.com', '');
//   const iotIndex = iotEndpoint.indexOf('iot');
//   return partial.substring(iotIndex + 4);
// }

module.exports = {
  publish,
  sendMessages,
  // sendChallenge,
  // sendAuthenticated,
  // getRegionFromEndpoint,
  getMessagesTopicForClient,
  includesClientMessagesTopic,
  getEndpoint
}
