
import { createBot } from '../../bot'

const bot = createBot()
const lambda = bot.lambdas.warmup()
export const handler = lambda.handler
