import { TYPE } from '@tradle/constants'
import parse = require('yargs-parser')
import { ICommand } from '../../../types'

export const command:ICommand = {
  name: 'message',
  description: 'sends a message',
  parse: (argsStr:string) => {
    const args = parse(argsStr)
    const { to, message } = args
    if (!(to && message)) {
      throw new Error('"to" and "message" are required')
    }

    return {
      to: args.to,
      object: {
        [TYPE]: 'tradle.SimpleMessage',
        message: args.message
      }
    }
  },

  exec: ({ context, args }) => context.bot.send(args)
}