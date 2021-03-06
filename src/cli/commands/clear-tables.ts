import Logger from '../../logger'
import Cli from '../'
import Command from '../command'
import { prettify } from '../../string-utils'

const skip = [
  'pubkeys',
  'presence',
  'events',
  'seals',
  'tradle_MyCloudFriend'
]

export default class ClearTables extends Command {
  public static requiresConfirmation = true
  public static description = 'this will clear tables in the REMOTE DynamoDB'
  private logger: Logger
  constructor (cli:Cli) {
    super(cli)
    this.logger = cli.logger.sub('clear-tables')
  }

  public exec = async (names) => {
    const tables = await this.getTables(names)
    await this.clearTables(tables)
  }

  private getTables = async (names) => {
    const { bot, env } = this
    if (names.length) {
      return names.map(name => {
        return name.startsWith(env.STACK_RESOURCE_PREFIX) ? name : env.STACK_RESOURCE_PREFIX + name
      })
    }

    const list = await bot.dbUtils.listTables(env)
    return list.filter(name => {
      return !skip.find(skippable => env.STACK_RESOURCE_PREFIX + skippable === name)
    })
  }

  private clearTables = async (names) => {
    const { href } = this.bot.aws.dynamodb.endpoint
    await this.confirm(`will empty the following tables at endpoint ${href}\n${prettify(names)}`)

    for (const table of names) {
      this.logger.debug('clearing', table)
      const numDeleted = await this.bot.dbUtils.clear(table)
      this.logger.debug(`deleted ${numDeleted} items from ${table}`)
    }
  }
}
