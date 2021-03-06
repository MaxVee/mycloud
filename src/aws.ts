import { EventEmitter } from 'events'
import rawAWS from 'aws-sdk'
import AWSXRay from 'aws-xray-sdk-core'
import { createConfig } from './aws-config'
import { Env, Logger } from './types'
import REGIONS from './aws-regions'
import { wrap } from './wrap-aws-client'
import { isXrayOn } from './utils'
import Errors from './errors'

const MOCKED_SEPARATELY = {
  KMS: true,
  Iot: true,
  STS: true,
}

type CreateRegionalService = (serviceName: string, region: string, conf?: any) => any

export interface AwsApis extends EventEmitter {
  s3: AWS.S3,
  dynamodb: AWS.DynamoDB,
  iam: AWS.IAM,
  iot: AWS.Iot,
  iotData: AWS.IotData,
  sts: AWS.STS,
  sns: AWS.SNS,
  ses: AWS.SES,
  kms: AWS.KMS,
  docClient: AWS.DynamoDB.DocumentClient,
  lambda: AWS.Lambda,
  cloudformation: AWS.CloudFormation,
  xray: AWS.XRay,
  apigateway: AWS.APIGateway,
  ssm: AWS.SSM,
  cloudwatch: AWS.CloudWatch,
  cloudwatchlogs: AWS.CloudWatchLogs,
  create: CreateRegionalService,
  AWS: any,
  trace: any
  regional: {
    [x: string]: AwsApis
  },
  getInstantiated: () => string[]
}

export const createAWSWrapper = ({ env, logger }: {
  env: Env
  logger: Logger
}) => {
  const region = env.AWS_REGION
  if (!REGIONS.includes(region)) {
    throw new Errors.InvalidEnvironment(`region does not exist: ${region}`)
  }

  const AWS = isXrayOn()
    ? AWSXRay.captureAWS(rawAWS)
    : rawAWS

  AWS.config.correctClockSkew = true

  const services = createConfig({
    region,
    local: env.IS_LOCAL,
  })

  AWS.config.update(services)

  const instanceNameToServiceName = {
    s3: 'S3',
    dynamodb: 'DynamoDB',
    dynamodbStreams: 'DynamoDBStreams',
    docClient: 'DocumentClient',
    iam: 'IAM',
    iot: 'Iot',
    sts: 'STS',
    sns: 'SNS',
    ses: 'SES',
    kms: 'KMS',
    lambda: 'Lambda',
    iotData: 'IotData',
    xray: 'XRay',
    apigateway: 'APIGateway',
    cloudwatch: 'CloudWatch',
    cloudwatchlogs: 'CloudWatchLogs',
    ssm: 'SSM',
    cloudformation: 'CloudFormation'
  }

  const useGlobalConfigClock = (service, name) => {
    if (service instanceof AWS.DynamoDB.DocumentClient) {
      service = service.service
    }

    if (!service.config) return

    Object.defineProperty(service.config, 'systemClockOffset', {
      get() {
        return AWS.config.systemClockOffset
      },
      set(value) {
        logger.warn(`setting systemClockOffset from service ${name}: ${value}`)
        AWS.config.systemClockOffset = value
      }
    })
  }

  const _create:CreateRegionalService = (serviceName, region, conf) => {
    if (serviceName === 'DocumentClient') {
      return new AWS.DynamoDB.DocumentClient(services.dynamodb)
    }

    if (serviceName === 'IotData') {
      // may be set dynamically
      const { IOT_ENDPOINT } = env
      return new AWS.IotData({
        endpoint: IOT_ENDPOINT,
        ...(conf || {})
      })
    }

    if (env.IS_TESTING && !conf && !MOCKED_SEPARATELY[serviceName]) {
      // don't pretend to support it as this will result
      // in calling the remote service!
      return null
    }

    return new AWS[serviceName]({ ...conf, region })
  }

  const create:CreateRegionalService = (serviceName, region) => {
    const conf = getConf(serviceName)
    const service = _create(serviceName, region, conf)
    if (service) {
      useGlobalConfigClock(service, serviceName)
      const recordable = wrap(service)
      apis.emit('new', {
        name: serviceName.toLowerCase(),
        service,
        recordable,
      })

      return recordable
    }
  }

  const getConf = (serviceName: string) => {
    return services[serviceName.toLowerCase()]
  }

  const apis:any = new EventEmitter()
  apis.regional = {}

  const { regional } = apis
  REGIONS.forEach(region => {
    const regionalServices = regional[region] = {}
    Object.keys(instanceNameToServiceName).forEach(instanceName => {
      let service
      const serviceName = instanceNameToServiceName[instanceName]
      Object.defineProperty(regionalServices, instanceName, {
        enumerable: true,
        get() {
          if (!service) {
            service = create(serviceName, region)
          }

          return service
        },
        set: value => {
          service = value
        }
      })
    })
  })

  const instantiated = {}

  // forward default to regional
  Object.keys(instanceNameToServiceName).forEach(instanceName => {
    const regional = apis.regional[region]
    Object.defineProperty(apis, instanceName, {
      enumerable: true,
      set: value => {
        instantiated[instanceName] = true
        regional[instanceName] = value
      },
      get: () => {
        const service = regional[instanceName]
        instantiated[instanceName] = true
        return service
      }
    })
  })

  apis.getInstantiated = () => Object.keys(instantiated)
  apis.AWS = AWS
  apis.xray = AWSXRay
  apis.trace = (() => {
    let segment
    return {
      start: () => {
        segment = AWSXRay.getSegment()
      },
      get: () => segment
    }
  })()

  apis.create = create
  return apis as AwsApis
}

export default createAWSWrapper
