import IotMessage from '@tradle/iot-message'
import { cachifyPromiser } from './utils'
import { AwsApis, Env, Logger } from './types'
const DEFAULT_QOS = 1

type IotOpts = {
  services: AwsApis
  env: Env
  prefix?: string
}

interface IIotPublishOpts {
  topic: string
  payload: any
  qos?: 0 | 1
}

export interface IIotEndpointInfo {
  parentTopic: string
  clientIdPrefix: string
}

const isATSEndpoint = endpoint => endpoint.includes('-ats.iot')

export default class Iot implements IIotEndpointInfo {
  public endpointInfo: IIotEndpointInfo
  public clientIdPrefix: string
  public parentTopic: string
  private services: AwsApis
  private iotData: AWS.IotData
  private env: Env
  private logger: Logger
  private prefix: string
  constructor({ services, env, prefix = '' }: IotOpts) {
    this.services = services
    this.env = env
    this.prefix = prefix
    this.iotData = null
    this.logger = env.logger.sub('iot-utils')
    this.clientIdPrefix = env.IOT_CLIENT_ID_PREFIX
    this.parentTopic = env.IOT_PARENT_TOPIC
    this.endpointInfo = {
      parentTopic: this.parentTopic,
      clientIdPrefix: this.clientIdPrefix,
    }
  }

  public publish = async (params: IIotPublishOpts) => {
    params = { ...params }
    if (!('qos' in params)) params.qos = DEFAULT_QOS

    params.payload = await IotMessage.encode({
      type: 'messages',
      payload: params.payload,
      encoding: 'gzip'
    })

    this.logger.debug(`publishing to ${params.topic}`)
    if (!this.iotData) {
      await this.getEndpoint()
      this.iotData = this.services.iotData
    }

    await this.iotData.publish(params).promise()
  }

  public fetchEndpoint = async () => {
    const { endpointAddress } = await this.services.iot.describeEndpoint({
      endpointType: 'iot:Data-ATS',
    }).promise()

    return endpointAddress
  }

  public getEndpoint = cachifyPromiser(async () => {
    // hack ./aws needs sync access to this var
    if (!(this.env.IOT_ENDPOINT && isATSEndpoint(this.env.IOT_ENDPOINT))) {
      this.env.IOT_ENDPOINT = await this.fetchEndpoint()
    }

    return this.env.IOT_ENDPOINT
  })
}

export const createUtils = (opts: IotOpts) => new Iot(opts)

export { Iot }
