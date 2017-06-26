const crypto = require('crypto')
const microtime = require('./microtime')
const typeforce = require('typeforce')
const debug = require('debug')('tradle:sls:utils')
const omit = require('object.omit')
const pick = require('object.pick')
const clone = require('xtend')
const extend = require('xtend/mutable')
const uuid = require('uuid')
const co = require('co').wrap
const promisify = require('pify')
const isGenerator = require('is-generator-function')
const { hexLink, addLinks, extractSigPubKey } = require('@tradle/engine').utils
const { prettify, stableStringify } = require('./string-utils')
const { SIG, TYPE, TYPES } = require('./constants')
const { MESSAGE } = TYPES

const utils = exports

exports.clone = clone
exports.extend = extend
exports.co = co
exports.omit = omit
exports.pick = pick
exports.typeforce = typeforce
exports.isGenerator = isGenerator
exports.uuid = uuid.v4
exports.promisify = promisify

exports.addLinks = utils.addLinks
exports.toECKeyObj = utils.toECKeyObj

exports.loudCo = function loudCo (gen) {
  return co(function* (...args) {
    try {
      return yield co(gen).apply(this, args)
    } catch (err) {
      console.error(err)
      throw err
    }
  })
}

exports.toBuffer = function toBuffer (data) {
  if (Buffer.isBuffer(data)) return data

  return new Buffer(stableStringify(data))
}

exports.now = function now () {
  return Date.now()
}

exports.groupBy = function groupBy (items, prop) {
  const groups = {}
  for (const item of items) {
    const val = item[prop]
    if (!groups[val]) {
      groups[val] = []
    }

    groups[val].push(item)
  }

  return groups
}

exports.cachifyPromiser = function cachifyPromiser (fn) {
  let promise
  return function (...args) {
    if (!promise) promise = fn(...args)

    return promise
  }
}

// trick from: https://stackoverflow.com/questions/37234191/resolve-es6-promise-with-first-success
exports.firstSuccess = function firstSuccess (promises) {
  return Promise.all(promises.map(p => {
    // If a request fails, count that as a resolution so it will keep
    // waiting for other possible successes. If a request succeeds,
    // treat it as a rejection so Promise.all immediately bails out.
    return p.then(
      val => Promise.reject(val),
      err => Promise.resolve(err)
    )
  })).then(
    // If '.all' resolved, we've just got an array of errors.
    errors => Promise.reject(errors),
    // If '.all' rejected, we've got the result we wanted.
    val => Promise.resolve(val)
  )
}

exports.uppercaseFirst = function uppercaseFirst (str) {
  return str[0].toUpperCase() + str.slice(1)
}

exports.logifyFunction = function logifyFunction ({ fn, name, log=debug, logInputOutput=false }) {
  return co(function* (...args) {
    const taskName = typeof name === 'function' ? name(...args) : name
    let start = Date.now()
    let duration
    let ret
    let err
    try {
      ret = yield fn(...args)
    } catch (e) {
      err = e
      throw err
    } finally {
      duration = Date.now() - start
      const parts = [
        taskName,
        err ? 'failed' : 'succeeded',
        `in ${duration}ms`
      ]

      if (logInputOutput) {
        parts.push('input:', prettify(args))
        if (!err) {
          parts.push('output:', prettify(ret))
        }
      }

      if (err) {
        parts.push(err.stack)
      }

      log(parts.join(' '))
    }

    return ret
  })
}

exports.logify = function logify (obj, opts={}) {
  const { log=debug, logInputOutput } = opts
  const logified = {}
  for (let p in obj) {
    let val = obj[p]
    if (typeof val === 'function') {
      logified[p] = utils.logifyFunction({
        fn: val,
        name: p,
        log,
        logInputOutput
      })
    } else {
      logified[p] = val
    }
  }

  return logified
}

// exports.timify = function timify (obj, opts={}) {
//   const { overwrite, log=debug } = opts
//   const timed = overwrite ? obj : {}
//   const totals = {}
//   Object.keys(obj).forEach((k) => {
//     const orig = obj[k]
//     if (typeof orig !== 'function') {
//       timed[k] = orig
//       return
//     }

//     const total = totals[k] = {
//       calls: 0,
//       time: 0
//     }

//     timed[k] = function (...args) {
//       const stopTimer = startTimer(k)
//       const ret = orig(...args)
//       if (!utils.isPromise(ret)) {
//         recordDuration()
//         return ret
//       }

//       return ret
//         .then(val => {
//           recordDuration()
//           return val
//         }, err => {
//           recordDuration()
//           throw err
//         })

//       function recordDuration () {
//         const ms = stopTimer()
//         total.time += ms
//         total.calls++
//         log(`${k} took ${ms}ms. ${total.calls} calls totaled ${total.time}ms`)
//       }
//     }
//   })

//   return timed
// }

const isPromise = obj => obj && typeof obj.then === 'function'
exports.isPromise = isPromise

exports.cachify = function cachify ({ get, put, cache }) {
  const pending = {}
  return {
    get: co(function* (key) {
      let val = cache.get(key)
      if (val != null) {
        debug(`cache hit on ${key}!`)
        // val might be a promise
        // the magic of co should resolve it
        // before returning
        return val
      }

      debug(`cache miss on ${key}`)
      const promise = get(key)
      promise.catch(err => cache.del(key))
      cache.set(key, promise)
      return promise
    }),
    put: co(function* (key, value) {
      // TODO (if actually needed):
      // get cached value, skip put if identical
      cache.del(key)
      const ret = yield put(key, value)
      cache.set(key, value)
      return ret
    })
  }
}

exports.timestamp = function timestamp () {
  return microtime.now()
}

exports.wait = function wait (millis=0) {
  return new Promise(resolve => setTimeout(resolve, millis))
}

exports.executeSuperagentRequest = function executeSuperagentRequest (req) {
  return req.then(res => {
    if (!res.ok) {
      throw new Error(res.text || `request to ${req.url} failed`)
    }
  })
}

exports.promiseCall = function promiseCall (fn, ...args) {
  return new Promise((resolve, reject) => {
    args.push(function (err, result) {
      if (err) return reject(err)

      resolve(result)
    })

    fn(...args)
  })
}

exports.series = co(function* (fns, ...args) {
  for (let fn of fns) {
    let maybePromise = fn(...args)
    if (isPromise(maybePromise)) {
      yield maybePromise
    }
  }
})

exports.seriesWithExit = co(function* (fns, ...args) {
  for (let fn of fns) {
    let keepGoing = fn(...args)
    if (isPromise(keepGoing)) {
      yield keepGoing
    }

    // enable exit
    if (keepGoing === false) return
  }
})

exports.waterfall = co(function* (fns, ...args) {
  let result
  for (let fn of fns) {
    result = fn(...args)
    if (isPromise(result)) {
      result = yield result
    }

    args = [result]
  }

  return result
})

function noop () {}

// function startTimer (name) {
//   const now = Date.now()
//   return function () {
//     return Date.now() - now
//   }
// }
