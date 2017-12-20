import Router = require('koa-router')
import { createBot } from '../../../bot'
import { EventSource } from '../../../lambda'
// import { customize } from '../../customize'

const bot = createBot()
const lambda = bot.lambdas.preauth()
// const promiseCustomize = customize({ bot, event: 'preauth' })

export const handler = lambda.handler
