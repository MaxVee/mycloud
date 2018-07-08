import { createBot } from '../../../'
import { fromSNS } from '../../lambda'
// import { createLambda } from '../../../in-house-bot/middleware/confirmation'
import { configureLambda } from '../../'
import * as LambdaEvents from '../../lambda-events'
import { parseStackStatusEvent } from '../../../utils'
import Errors from '../../../errors'

const bot = createBot()
const lambda = fromSNS({ bot, event: 'confirmation' })
const promiseComponents = configureLambda({ lambda, event: LambdaEvents.CHILD_STACK_STATUS_CHANGED })
lambda.use(async (ctx) => {
  const { deployment } = await promiseComponents
  const { event } = ctx
  let parsed
  try {
    parsed = parseStackStatusEvent(event)
  } catch (err) {
    lambda.logger.error('received invalid stack status event', event)
    return
  }

  try {
    await deployment.setChildStackStatus(parsed)
  } catch (err) {
    Errors.ignoreNotFound(err)
    ctx.status = 400
    ctx.body = { message: 'invalid notification' }
  }
})

export const handler = lambda.handler
