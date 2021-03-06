import { fromCloudFormation } from '../lambda'

export const createLambda = (opts) => {
  const lambda = fromCloudFormation(opts)
  const { bot, logger } = lambda
  return lambda.use(async (ctx, next) => {
    const { event } = ctx
    await bot.fire(`stack:${event.type}`, ctx.event)
    await next()
  })
}
