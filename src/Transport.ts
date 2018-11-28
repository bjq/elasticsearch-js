'use strict'

/* eslint-disable no-unused-vars, camelcase */
import once from 'once'
import ms from 'ms'
import Debug from 'debug'
import ConnectionPool from './ConnectionPool'
import Connection from './Connection'
import http from 'http'
import Serializer from './Serializer'
import {
  ConnectionError,
  TimeoutError,
  NoLivingConnectionsError,
  ResponseError
} from './errors'
/* eslint-enable no-unused-vars */

const debug = Debug('elasticsearch')
const noop = (...args: any[]): void => {}
const kRemainingAttempts = Symbol('elasticsearch-remaining-attempts')

type noopFn = (...args: any[]) => void
type emitFn = (event: string | symbol, ...args: any[]) => boolean

interface TransportOptions {
  emit: emitFn & noopFn
  connectionPool: ConnectionPool
  serializer: Serializer
  maxRetries: number
  requestTimeout: number | string
  suggestCompression: boolean
  sniffInterval: number
  sniffOnConnectionFault: boolean
  sniffEndpoint: string
  sniffOnStart: boolean
}

export interface ApiResponse {
  body: any
  statusCode: number | null
  headers: any
  warnings: any[] | null
}

export default class Transport {
  emit: emitFn & noopFn
  connectionPool: ConnectionPool
  serializer: Serializer
  maxRetries: number
  requestTimeout: number
  suggestCompression: boolean
  sniffInterval: number
  sniffOnConnectionFault: boolean
  sniffEndpoint: string
  _sniffEnabled: boolean
  _nextSniff: number
  _isSniffing: boolean
  constructor (opts: TransportOptions) {
    this.emit = opts.emit || noop
    this.connectionPool = opts.connectionPool
    this.serializer = opts.serializer
    this.maxRetries = opts.maxRetries
    this.requestTimeout = toMs(opts.requestTimeout)
    this.suggestCompression = opts.suggestCompression === true
    this.sniffInterval = opts.sniffInterval
    this.sniffOnConnectionFault = opts.sniffOnConnectionFault
    this.sniffEndpoint = opts.sniffEndpoint

    this._sniffEnabled = typeof this.sniffInterval === 'number'
    this._nextSniff = this._sniffEnabled ? (Date.now() + this.sniffInterval) : 0
    this._isSniffing = false

    if (opts.sniffOnStart === true) {
      this.sniff()
    }
  }

  request (params: any, callback: (err: Error | null, result: ApiResponse) => void): any {
    callback = once(callback)
    const result: ApiResponse = { body: null, statusCode: null, headers: null, warnings: null }
    const attempts: number = params[kRemainingAttempts] || params.maxRetries || this.maxRetries
    const connection: Connection | null = this.getConnection()
    if (connection === null) {
      return callback(new NoLivingConnectionsError('There are not living connections'), result)
    }

    params.headers = params.headers || {}
    // handle json body
    if (params.body != null) {
      if (shouldSerialize(params.body) === true) {
        try {
          params.body = this.serializer.serialize(params.body)
        } catch (err) {
          return callback(err, result)
        }
      }
      params.headers['Content-Type'] = 'application/json'
      if (isStream(params.body) === false) {
        params.headers['Content-Length'] = '' + Buffer.byteLength(params.body)
      }
    // handle ndjson body
    } else if (params.bulkBody != null) {
      if (shouldSerialize(params.bulkBody) === true) {
        try {
          params.body = this.serializer.ndserialize(params.bulkBody)
        } catch (err) {
          return callback(err, result)
        }
      } else {
        params.body = params.bulkBody
      }
      params.headers['Content-Type'] = 'application/x-ndjson'
      if (isStream(params.body) === false) {
        params.headers['Content-Length'] = '' + Buffer.byteLength(params.body)
      }
    }

    if (this.suggestCompression === true) {
      params.headers['Accept-Encoding'] = 'gzip,deflate'
    }

    // serializes the querystring
    params.querystring = this.serializer.qserialize(params.querystring)
    // handles request timeout
    params.timeout = toMs(params.requestTimeout || this.requestTimeout)

    this.emit('request', connection, params)

    // perform the actual http request
    const request: http.ClientRequest = connection.request(params, (err: Error | null, response: http.IncomingMessage | null) => {
      if (err !== null) {
        // if there is an error in the connection
        // let's mark the connection as dead
        this.connectionPool.markDead(connection)

        if (this.sniffOnConnectionFault === true) {
          this.sniff()
        }

        // retry logic
        if (attempts > 0) {
          debug(`Retrying request, there are still ${attempts} attempts`, params)
          params[kRemainingAttempts] = attempts - 1
          return this.request(params, callback)
        }

        const error = err instanceof TimeoutError
          ? err
          : new ConnectionError(err.message, params)

        this.emit('error', error, connection, params)
        return callback(error, result)
      }

      const { statusCode, headers } = response!
      result.statusCode = statusCode!
      result.headers = headers!
      if (headers['warning'] != null) {
        // split the string over the commas not inside quotes
        result.warnings = headers['warning'].split(/(?!\B"[^"]*),(?![^"]*"\B)/)
      }

      if (params.asStream === true) {
        result.body = response
        this.emit('response', connection, params, result)
        callback(null, result)
        return
      }

      var payload: string = ''
      // collect the payload
      response!.setEncoding('utf8')
      response!.on('data', (chunk: string) => { payload += chunk })
      response!.on('error', (err: Error) => callback(new ConnectionError(err.message, params), result))
      response!.on('end', () => {
        const isHead: boolean = params.method === 'HEAD'
        // we should attempt the payload deserialization only if:
        //    - a `content-type` is defined and is equal to `application/json`
        //    - the request is not a HEAD request
        //    - the payload is not an empty string
        if (headers['content-type'] != null &&
            headers['content-type'].indexOf('application/json') > -1 &&
            isHead === false &&
            payload !== ''
        ) {
          try {
            result.body = this.serializer.deserialize(payload)
          } catch (err) {
            this.emit('error', err, connection, params)
            return callback(err, result)
          }
        } else {
          // cast to boolean if the request method was HEAD
          result.body = isHead === true ? true : payload
        }

        // we should ignore the statusCode if the user has configured the `ignore` field with
        // the statusCode we just got or if the request method is HEAD and the statusCode is 404
        const ignoreStatusCode = (Array.isArray(params.ignore) && params.ignore.indexOf(statusCode) > -1) ||
          (isHead === true && statusCode === 404)

        if (ignoreStatusCode === false &&
           (statusCode === 502 || statusCode === 503 || statusCode === 504)) {
          // if the statusCode is 502/3/4 we should run our retry strategy
          // and mark the connection as dead
          this.connectionPool.markDead(connection)
          if (attempts > 0) {
            debug(`Retrying request, there are still ${attempts} attempts`, params)
            params[kRemainingAttempts] = attempts - 1
            return this.request(params, callback)
          }
        } else {
          // everything has worked as expected, let's mark
          // the connection as alive (or confirm it)
          this.connectionPool.markAlive(connection)
        }

        this.emit('response', connection, params, result)
        if (ignoreStatusCode === false && statusCode! >= 400) {
          callback(new ResponseError(result), result)
        } else {
          // cast to boolean if the request method was HEAD
          if (isHead === true && statusCode === 404) {
            result.body = false
          }
          callback(null, result)
        }
      })
    })

    return {
      abort: () => {
        request.abort()
        debug('Request aborted', params)
      }
    }
  }

  getConnection (): Connection | null {
    const now = Date.now()
    if (this._sniffEnabled === true && now > this._nextSniff) {
      this.sniff()
    }
    this.connectionPool.resurrect(now)
    return this.connectionPool.getConnection()
  }

  sniff (callback = noop): void {
    if (this._isSniffing === true) return
    this._isSniffing = true
    debug('Started sniffing request')

    const request = {
      method: 'GET',
      path: this.sniffEndpoint
    }

    this.request(request, (err, result) => {
      this._isSniffing = false
      if (this._sniffEnabled === true) {
        this._nextSniff = Date.now() + this.sniffInterval
      }

      if (err != null) {
        this.emit('error', err, null, request)
        debug('Sniffing errored', err)
        return callback(err)
      }

      debug('Sniffing ended successfully', result.body)
      const hosts = this.connectionPool.nodesToHost(result.body.nodes)
      this.connectionPool.update(hosts)

      callback(null, hosts)
    })
  }
}

function toMs (time: string | number): number {
  if (typeof time === 'string') {
    return ms(time)
  }
  return time
}

function shouldSerialize (obj: any): boolean {
  return typeof obj !== 'string' &&
         typeof obj.pipe !== 'function' &&
         Buffer.isBuffer(obj) === false
}

function isStream (obj: any): boolean {
  return typeof obj.pipe === 'function'
}
