var anonize = require('node-anonize2-relic')
var boom = require('boom')
var braveHapi = require('../brave-hapi')
var braveJoi = require('../brave-joi')
var bson = require('bson')
var Joi = require('joi')
const moment = require('moment')
var underscore = require('underscore')

var v1 = {}

var server = async function (request, reply, runtime) {
  var entry, surveyor
  var debug = braveHapi.debug(module, request)
  var surveyorType = request.params.surveyorType
  var surveyorId = request.params.surveyorId
  var surveyors = runtime.db.get('surveyors', debug)

  if ((surveyorId === 'current') && (surveyorType === 'contribution')) {
    entry = await surveyors.findOne({ surveyorType: surveyorType, active: true })
  } else {
    entry = await surveyors.findOne({ surveyorId: surveyorId })
  }
  if (!entry) reply(boom.notFound('surveyor does not exist: ' + surveyorId))
  else if (entry.surveyorType !== surveyorType) reply(boom.badData('surveyorType mismatch for: ' + surveyorId))
  else {
    surveyor = new anonize.Surveyor(entry.parameters)
    surveyor.surveyorId = entry.surveyorId
    surveyor.surveyorType = entry.surveyorType
    surveyor.payload = entry.payload
    surveyor.parentId = entry.parentId
  }

  return surveyor
}

var registrarType = function (surveyorType) {
  return { contribution: 'persona', voting: 'viewing' }[surveyorType]
}

var validate = function (surveyorType, payload) {
  var fee = Joi.object().keys({ USD: Joi.number().min(1).required() }).unknown(true).required()
  var satoshis = Joi.number().integer().min(1).optional()
  var votes = Joi.number().integer().min(1).max(100).required()
  var schema = {
    contribution: Joi.object().keys({ adFree: Joi.object().keys({ votes: votes, satoshis: satoshis, fee: fee }) }).required()
  }[surveyorType] || Joi.object().max(0)

  return Joi.validate(payload || {}, schema)
}

var enumerate = function (runtime, surveyorType, payload) {
  var satoshis
  var params = (payload || {}).adFree

  if ((surveyorType !== 'contribution') || (typeof params === 'undefined')) return payload

  params = payload.adFree
  underscore.keys(params.fee).forEach(function (currency) {
    var amount = params.fee[currency]
    var rate = runtime.wallet.rates[currency.toUpperCase()]

    if ((satoshis) || (!rate)) return

    satoshis = Math.round((amount / rate) * 1e8)
  })
  if (!satoshis) return

  payload.adFree.satoshis = satoshis
  return payload
}

/*
   GET /v1/surveyor/{surveyorType}/{surveyorId}
 */

v1.read =
{ handler: function (runtime) {
  return async function (request, reply) {
    var surveyor
    var debug = braveHapi.debug(module, request)
    var surveyorType = request.params.surveyorType

    surveyor = await server(request, reply, runtime)
    if (!surveyor) return

    reply(underscore.extend({ payload: surveyor.payload }, surveyor.publicInfo()))

    if (surveyorType === 'contribution') provision(debug, runtime, surveyor.surveyorId)
  }
},

  description: 'Returns information about a surveyor',
  tags: [ 'api' ],

  validate:
    { params:
      { surveyorType: Joi.string().valid('contribution', 'voting').required().description('the type of the surveyor'),
        surveyorId: Joi.string().required().description('the identity of the surveyor')
      }
    },

  response:
    { schema: Joi.object().keys(
      {
        surveyorId: Joi.string().required().description('identifier for the surveyor'),
        surveyVK: Joi.string().required().description('public key for the surveyor'),
        registrarVK: Joi.string().required().description('public key for the associated registrar'),
        payload: Joi.object().required().description('additional information')
      })
    }
}

/*
   POST /v1/surveyor/{surveyorType}
 */

v1.create =
{ handler: function (runtime) {
  return async function (request, reply) {
    var surveyor, validity
    var debug = braveHapi.debug(module, request)
    var surveyorType = request.params.surveyorType
    var payload = request.payload || {}

    validity = validate(surveyorType, payload)
    if (validity.error) return reply(boom.badData(validity.error))

    payload = enumerate(runtime, surveyorType, payload)
    if (!payload) return reply(boom.badData('no available currencies'))

    surveyor = await create(debug, runtime, surveyorType, payload)
    if (!surveyor) return reply(boom.notFound('invalid surveyorType: ' + surveyorType))

    reply(underscore.extend({ payload: payload }, surveyor.publicInfo()))
  }
},

  auth:
    { strategy: 'session',
      scope: [ 'ledger' ],
      mode: 'required'
    },

  description: 'Creates a new surveyor',
  tags: [ 'api' ],

  validate:
    { params:
      { surveyorType: Joi.string().valid('contribution', 'voting').required().description('the type of the surveyor') },
      payload: Joi.object().optional().description('additional information')
    },

  response:
    { schema: Joi.object().keys(
      {
        surveyorId: Joi.string().required().description('identifier for the surveyor'),
        surveyVK: Joi.string().required().description('public key for the surveyor'),
        registrarVK: Joi.string().required().description('public key for the associated registrar'),
        payload: Joi.object().optional().description('additional information')
      })
    }
}

/*
   PATCH /v1/surveyor/{surveyorType}/{surveyorId}
 */

v1.update =
{ handler: function (runtime) {
  return async function (request, reply) {
    var state, surveyor, validity
    var debug = braveHapi.debug(module, request)
    var surveyorType = request.params.surveyorType
    var payload = request.payload || {}
    var surveyors = runtime.db.get('surveyors', debug)

    surveyor = await server(request, reply, runtime)
    if (!surveyor) return

    validity = validate(surveyorType, payload)
    if (validity.error) return reply(boom.badData(validity.error))

    payload = enumerate(runtime, surveyorType, payload)
    if (!payload) return reply(boom.badData('no available currencies'))

    state = { $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { payload: payload }
            }
    await surveyors.update({ surveyorId: surveyor.surveyorId }, state, { upsert: false })

    if (surveyorType === 'contribution') {
      await runtime.queue.send(debug, 'surveyor-report',
                               underscore.extend({ surveyorId: surveyor.surveyorId, surveyorType: surveyorType },
                                                 underscore.pick(payload.adFree, [ 'satoshis', 'votes' ])))
    }

    surveyor.payload = payload
    reply(underscore.extend({ payload: payload }, surveyor.publicInfo()))

    if (surveyorType === 'contribution') provision(debug, runtime, surveyor.surveyorId)
  }
},

  auth:
    { strategy: 'session',
      scope: [ 'ledger' ],
      mode: 'required'
    },

  description: 'Updates a surveyor',
  tags: [ 'api' ],

  validate:
    { params:
      { surveyorType: Joi.string().valid('contribution', 'voting').required().description('the type of the surveyor'),
        surveyorId: Joi.string().required().description('the identity of the surveyor')
      },
      payload: Joi.object().optional().description('additional information')
    },

  response:
    { schema: Joi.object().keys(
      {
        surveyorId: Joi.string().required().description('identifier for the surveyor'),
        surveyVK: Joi.string().required().description('public key for the surveyor'),
        registrarVK: Joi.string().required().description('public key for the associated registrar'),
        payload: Joi.object().optional().description('additional information')
      })
    }
}

/*
   GET /v1/surveyor/{surveyorType}/{surveyorId}/{uId}
 */

v1.phase1 =
{ handler: function (runtime) {
  return async function (request, reply) {
    var entry, f, registrar, now, signature, surveyor
    var debug = braveHapi.debug(module, request)
    var surveyorId = request.params.surveyorId
    var surveyorType = request.params.surveyorType
    var uId = request.params.uId.toLowerCase()
    var credentials = runtime.db.get('credentials', debug)

    surveyor = await server(request, reply, runtime)
    if (!surveyor) return

    registrar = runtime.registrars[registrarType(surveyorType)]
    if (!registrar) return reply(boom.badImplementation('unable to find registrar for ' + surveyorType))

    entry = await credentials.findOne({ uId: uId, registrarId: registrar.registrarId })

    f = { contribution:
            async function () {
              if (!entry) return reply(boom.notFound('personaId not valid: ' + uId))
            },

          voting:
            async function () {
              var viewing
              var viewings = runtime.db.get('viewings', debug)

              if (!entry) return reply(boom.notFound('viewingId not valid(1): ' + uId))

              viewing = await viewings.findOne({ uId: uId })
              if (!viewing) return reply(boom.notFound('viewingId not valid(2): ' + uId))

              if (viewing.surveyorIds.indexOf(surveyorId) === -1) return reply(boom.notFound('viewingId not valid(3): ' + uId))
            }
        }[surveyor.surveyorType]
    if ((!!f) && (await f())) return

    now = underscore.now()
    signature = surveyor.sign(uId)
    runtime.newrelic.recordCustomEvent('sign',
                                       { surveyorId: surveyor.surveyorId,
                                         surveyorType: surveyor.surveyorType,
                                         duration: underscore.now() - now })

    reply(underscore.extend({ signature: signature, payload: surveyor.payload }, surveyor.publicInfo()))
  }
},

  description: 'Generates an initialization response for a surveyor',
  tags: [ 'api' ],

  validate:
    { params:
      { surveyorType: Joi.string().valid('contribution', 'voting').required().description('the type of the surveyor'),
        surveyorId: Joi.string().required().description('the identity of the surveyor'),
        uId: Joi.string().length(31).required().description('the universally-unique identifier')
      }
    },

  response:
    { schema: Joi.object().keys(
      {
        surveyorId: Joi.string().required().description('identifier for the surveyor'),
        surveyVK: Joi.string().required().description('public key for the surveyor'),
        registrarVK: Joi.string().required().description('public key for the associated registrar'),
        signature: Joi.string().required().description('initialization response for the surveyor'),
        payload: Joi.object().optional().description('additional information')
      })
    }
}

/*
   PUT /v1/surveyor/{surveyorType}/{surveyorId}
 */

v1.phase2 =
{ handler: function (runtime) {
  return async function (request, reply) {
    var data, entry, f, response, now, result, state, submissionId, surveyor
    var debug = braveHapi.debug(module, request)
    var proof = request.payload.proof
    var submissions = runtime.db.get('submissions', debug)

    surveyor = await server(request, reply, runtime)
    if (!surveyor) return

    try {
      now = underscore.now()
      result = surveyor.verify(proof)
      runtime.newrelic.recordCustomEvent('verify',
                                         { surveyorId: surveyor.surveyorId,
                                           surveyorType: surveyor.surveyorType,
                                           duration: underscore.now() - now })
      data = JSON.parse(result.data)
    } catch (ex) {
      return reply(boom.badData('invalid surveyor proof: ' + JSON.stringify(proof)))
    }
    submissionId = result.token

    entry = await submissions.findOne({ submissionId: submissionId })
    if (entry) {
// NB: in case of a network error on the response (or a premature Heroku 503, etc.)
      return reply(entry.response)
    }

    response = { submissionId: submissionId }
    f = { contribution:
            async function () {
              var schema = Joi.object().keys({ viewingId: Joi.string().guid().required() })
              var validity = Joi.validate(data.report, schema)

              if (validity.error) return reply(boom.badData(validity.error))
            },

          voting:
            async function () {
              var schema = Joi.object().keys({ publisher: braveJoi.string().publisher().required() })
              var validity = Joi.validate(data, schema)

              if (validity.error) return reply(boom.badData(validity.error))

              await runtime.queue.send(debug, 'voting-report', underscore.extend({ surveyorId: surveyor.parentId }, data))
            }
        }[surveyor.surveyorType]
    if ((!!f) && (await f())) return

    state = { $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { response: response }
            }
    await submissions.update({ submissionId: submissionId }, state, { upsert: true })

    reply(response)
  }
},

  description: 'Submits a completed report',
  tags: [ 'api' ],

  validate:
    { params:
      { surveyorType: Joi.string().valid('contribution', 'voting').required().description('the type of the surveyor'),
        surveyorId: Joi.string().required().description('the identity of the surveyor')
      },

      payload: { proof: Joi.string().required().description('report information and proof') }
    },

  response:
    { schema: Joi.object().keys({ submissionId: Joi.string().required().description('verification submissionId') }) }
}

var create = async function (debug, runtime, surveyorType, payload, parentId) {
  var registrar, state, surveyor
  var surveyors = runtime.db.get('surveyors', debug)

  registrar = runtime.registrars[registrarType(surveyorType)]
  if (!registrar) return

  surveyor = new anonize.Surveyor().initialize(registrar.publicInfo().registrarVK)
  surveyor.surveyorId = surveyor.parameters.surveyorId
  surveyor.surveyorType = surveyorType
  surveyor.payload = payload

  state = { $currentDate: { timestamp: { $type: 'timestamp' } },
            $set: underscore.extend({ surveyorType: surveyorType, active: surveyorType !== 'contribution', available: true,
                                      payload: payload }, surveyor)
          }
  if (parentId) state.$set.parentId = parentId
  await surveyors.update({ surveyorId: surveyor.surveyorId }, state, { upsert: true })

  if (surveyorType !== 'contribution') return surveyor

  provision(debug, runtime, surveyor.surveyorId)

  state = { $set: { active: false } }
  await surveyors.update({ surveyorType: 'contribution', active: true }, state, { upsert: false, multi: true })

  state = { $set: { active: true } }
  await surveyors.update({ surveyorId: surveyor.surveyorId }, state, { upsert: false })

  await runtime.queue.send(debug, 'surveyor-report',
                           underscore.extend({ surveyorId: surveyor.surveyorId, surveyorType: surveyorType },
                                             underscore.pick(payload.adFree, [ 'satoshis', 'votes' ])))

  return surveyor
}

var daily = async function (debug, runtime) {
  var entries, midnight, tomorrow
  var now = underscore.now()
  var surveyorType = 'contribution'
  var surveyors = runtime.db.get('surveyors', debug)

  debug('daily', 'running')

  midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  midnight = Math.floor(midnight.getTime() / 1000)

  entries = await surveyors.find({ surveyorType: surveyorType, active: true }, { limit: 100, sort: { timestamp: -1 } })
  entries.forEach(async function (entry) {
    var payload, surveyor, validity

    if (entry.timestamp.high_ >= midnight) return

    validity = validate(surveyorType, entry.payload)
    if (validity.error) return debug('daily', 'unable to create surveyorType=' + surveyorType + ': ' + validity.error)

    payload = enumerate(runtime, surveyorType, entry.payload)
    if (!payload) return debug('daily', 'no available currencies' + JSON.stringify(entry.payload))

    surveyor = await create(debug, runtime, surveyorType, payload)
    if (!surveyor) return debug('daily', 'unable to create surveyorType=' + surveyorType)

    debug('daily', 'created ' + surveyorType + ' surveyorID=' + surveyor.surveyorId)
  })

  tomorrow = new Date(now)
  tomorrow.setHours(24, 0, 0, 0)
  setTimeout(function () { daily(debug, runtime) }, tomorrow - now)
  debug('daily', 'running again ' + moment(tomorrow).fromNow())
}

var provision = async function (debug, runtime, surveyorId) {
  var entries, entry
  var surveyors = runtime.db.get('surveyors', debug)

  if (surveyorId) {
    entries = []
    entry = await surveyors.findOne({ surveyorId: surveyorId })
    if (entry) entries.push(entry)
  } else {
    entries = await surveyors.find({ surveyorType: 'contribution', available: true }, { limit: 1000, sort: { timestamp: -1 } })
  }
  entries.forEach(async function (entry) {
    var count, surveyor

    if (!entry.surveyors) entry.surveyors = []
    count = (entry.payload.adFree.votes * 4) - entry.surveyors.length
    if (count < 1) return

    debug('surveyor', 'creating ' + count + ' voting surveyors for ' + entry.surveyorId)
    while (count > 0) {
      surveyor = await create(debug, runtime, 'voting', {}, entry.surveyorId)
      if (!surveyor) return debug('surveyor', 'unable to create ' + count + ' voting surveyors')

      entry.surveyors.push(surveyor.surveyorId)

      count--
    }

    await surveyors.update({ surveyorId: entry.surveyorId }, { $set: { surveyors: entry.surveyors } }, { upsert: true })
  })
}

module.exports.routes = [
  braveHapi.routes.async().path('/v1/surveyor/{surveyorType}/{surveyorId}').config(v1.read),
  braveHapi.routes.async().post().path('/v1/surveyor/{surveyorType}').config(v1.create),
  braveHapi.routes.async().patch().path('/v1/surveyor/{surveyorType}/{surveyorId}').config(v1.update),
  braveHapi.routes.async().path('/v1/surveyor/{surveyorType}/{surveyorId}/{uId}').config(v1.phase1),
  braveHapi.routes.async().put().path('/v1/surveyor/{surveyorType}/{surveyorId}').config(v1.phase2)
]

module.exports.initialize = async function (debug, runtime) {
  var entry, i, service, services, surveyor, surveyorType
  var configurations = process.env.SURVEYORS || 'contribution,voting'
  var surveyors = runtime.db.get('surveyors', debug)

  runtime.db.checkIndices(debug,
  [ { category: surveyors,
      name: 'surveyors',
      property: 'surveyorId',
      empty: { surveyorId: '', surveyorType: '', active: false, available: false, payload: {}, timestamp: bson.Timestamp.ZERO },
      unique: [ { surveyorId: 0 } ],
      others: [ { surveyorType: 1 }, { active: 1 }, { available: 1 }, { timestamp: 1 } ]
    },
    { category: runtime.db.get('submissions', debug),
      name: 'submissions',
      property: 'submissionId',
      empty: { submissionId: '', surveyorId: '', timestamp: bson.Timestamp.ZERO },
      unique: [ { submissionId: 0 } ],
      others: [ { surveyorId: 0 }, { timestamp: 1 } ]
    }
  ])

  await runtime.queue.create('surveyor-report')
  await runtime.queue.create('voting-report')

  services = configurations.split(',')
  for (i = services.length - 1; i >= 0; i--) {
    service = services[i].split(':')
    surveyorType = service[0]

    entry = await surveyors.findOne({ surveyorType: surveyorType, active: true })
    if (entry) {
      surveyor = new anonize.Surveyor(entry.parameters)
      surveyor.surveyorId = entry.surveyorId
      surveyor.surveyorType = surveyorType
      surveyor.payload = entry.payload

      if ((surveyorType === 'contribution') ||
            ((typeof process.env.DYNO !== 'undefined') && (process.env.DYNO !== 'web.1'))) continue

      setTimeout(function () { provision(debug, runtime, surveyor.surveyorId) }, 5 * 1000)
    }
  }

/*
  if ((typeof process.env.DYNO === 'undefined') || (process.env.DYNO === 'web.1')) {
    setTimeout(function () { daily(debug, runtime) }, 5 * 1000)
  }
 */
}
