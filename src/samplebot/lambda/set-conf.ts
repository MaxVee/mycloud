// @ts-ignore
import Promise = require('bluebird')
import { EventSource } from '../../lambda'
import { Conf, createConf } from '../configure'
import { createBot } from '../../bot'

const bot = createBot()
const lambda = bot.createLambda({ source: EventSource.LAMBDA })
const conf = createConf({ bot })

lambda.use(async (ctx) => {
  const { style, botConf, models, terms } = ctx.event
  await conf.update({ style, bot: botConf, models, terms })
  await conf.forceReinitializeContainers()
})

export const handler = lambda.handler
