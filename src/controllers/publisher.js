var boom = require('boom')
var braveHapi = require('../brave-hapi')
var bson = require('bson')
var Joi = require('joi')
var ledgerPublisher = require('ledger-publisher')
var tldjs = require('tldjs')
var underscore = require('underscore')

var v1 = {}

var rulesetId = 1

var rulesetEntry = async function (request, runtime) {
  var entry
  var debug = braveHapi.debug(module, request)
  var version = runtime.npminfo.children['ledger-publisher']
  var rulesets = runtime.db.get('rulesets', debug)

  entry = await rulesets.findOne({ rulesetId: rulesetId })
  if ((!entry) || (entry.version.indexOf(version) !== 0)) {
    if (entry) rulesets.remove({ rulesetId: rulesetId })

    entry = { ruleset: ledgerPublisher.ruleset, version: version }
  }

  return entry
}

/*
   GET /v1/publisher/ruleset
 */

v1.read =
{ handler: function (runtime) {
  return async function (request, reply) {
    var entry = await rulesetEntry(request, runtime)

    reply(entry.ruleset)
  }
},

  description: 'Returns the publisher identity ruleset',
  tags: [ 'api' ],

  validate:
    { query: {} },

  response:
    { schema: ledgerPublisher.schema }
}

/*
   POST /v1/publisher/ruleset
 */

v1.create =
{ handler: function (runtime) {
  return async function (request, reply) {
    var state
    var debug = braveHapi.debug(module, request)
    var version = runtime.npminfo.children['ledger-publisher'] + '-' + underscore.now()
    var rulesets = runtime.db.get('rulesets', debug)

    state = { $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { ruleset: request.payload, version: version, type: 'publisher/ruleset' }
            }
    await rulesets.update({ rulesetId: rulesetId }, state, { upsert: true })

    reply(version)
  }
},

  auth:
    { strategy: 'session',
      scope: [ 'ledger' ],
      mode: 'required'
    },

  description: 'Defines the publisher identity ruleset',
  tags: [ 'api' ],

  validate:
    { payload: ledgerPublisher.schema },

  response:
    { schema: Joi.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+-[1-9][0-9]+$/) }
}

/*
   DELETE /v1/publisher/ruleset
 */

v1.delete =
{ handler: function (runtime) {
  return async function (request, reply) {
    var debug = braveHapi.debug(module, request)
    var rulesets = runtime.db.get('rulesets', debug)

    await rulesets.remove({ rulesetId: rulesetId })

    reply(runtime.npminfo.children['ledger-publisher'])
  }
},

  auth:
    { strategy: 'session',
      scope: [ 'ledger' ],
      mode: 'required'
    },

  description: 'Resets the publisher identity ruleset',
  tags: [ 'api' ],

  validate:
    { query: {} },

  response:
    { schema: Joi.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/) }
}

/*
   GET /v1/publisher/ruleset/version
 */

v1.version =
{ handler: function (runtime) {
  return async function (request, reply) {
    var entry = await rulesetEntry(request, runtime)

    reply(entry.version)
  }
},

  description: 'Returns the version of the publisher identity ruleset',
  tags: [ 'api' ],

  validate:
    { query: {} },

  response:
    { schema: Joi.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(-[1-9]+[0-9]*)?$/) }
}

/*
   GET /v1/publisher/identity?url=...
 */

v1.identity =
{ handler: function (runtime) {
  return async function (request, reply) {
    var result
    var url = request.query.url

    try {
      result = ledgerPublisher.getPublisherProps(url)
      if (result) result.publisher = ledgerPublisher.getPublisher(url)

      reply(result || boom.notFound())
    } catch (err) {
      reply(boom.badData(err.toString()))
    }
  }
},

  description: 'Returns the publisher identity associated with a URL',
  tags: [ 'api' ],

  validate:
    { query: { url: Joi.string().uri({ scheme: /https?/ }).required().description('the URL to parse') } },

  response:
    { schema: Joi.object().optional().description('the publisher identity') }
}

/*
   GET /v1/publisher/verified
 */

v1.verified =
{ handler: function (runtime) {
  return async function (request, reply) {
    var entries, query, result
    var limit = request.query.limit
    var substring = request.query.substring
    var tld = request.query.tld
    var debug = braveHapi.debug(module, request)
    var publishers = runtime.db.get('publishers', debug)

    query = { verified: true, tld: tld }
    if (substring) query.$text = { $search: substring }
    entries = await publishers.find(query, { limit: limit })
    result = []
    entries.forEach((entry) => { result.push(entry.publisher) })
    reply(result)
  }
},

  description: 'Returns a list of verified publishers',
  tags: [ 'api' ],

  validate:
    { query: { limit: Joi.number().integer().min(1).default(500).description('maximum number of matches'),
               substring: Joi.string().hostname().optional().description('a string to match '),
               tld: Joi.string().hostname().optional().description('a suffix-matching string') } },

  response:
    { schema: Joi.array().items(Joi.string()).description('verified publishers') }
}

module.exports.routes = [
  braveHapi.routes.async().get().path('/v1/publisher/ruleset').config(v1.read),
  braveHapi.routes.async().post().path('/v1/publisher/ruleset').config(v1.create),
  braveHapi.routes.async().delete().path('/v1/publisher/ruleset').config(v1.delete),
  braveHapi.routes.async().get().path('/v1/publisher/ruleset/version').config(v1.version),
  braveHapi.routes.async().get().path('/v1/publisher/identity').config(v1.identity),
  braveHapi.routes.async().get().path('/v1/publisher/verified').config(v1.verified)
]

module.exports.initialize = async function (debug, runtime) {
  var entry, validity
  var rulesets = runtime.db.get('rulesets', debug)

  runtime.db.checkIndices(debug,
  [ { category: rulesets,
      name: 'rulesets',
      property: 'rulesetId',
      empty: { rulesetId: 0, type: '', version: '', timestamp: bson.Timestamp.ZERO },
      unique: [ { rulesetId: 1 } ],
      others: [ { type: 1 }, { version: 1 }, { timestamp: 1 } ]
    },
    { category: runtime.db.get('publishers', debug),
      name: 'publishers',
      property: 'publisher',
      empty: { publisher: '', tld: '', verified: false, timestamp: bson.Timestamp.ZERO },
      unique: [ { publisher: 1 } ],
      others: [ { tld: 1 }, { verified: 1 }, { timestamp: 1 } ],
      raw: [ { publisher: 'text' } ]
    }
  ])
  console.log(JSON.stringify(runtime.db.get('publishers', debug).indexes(), null, 2))

  entry = await rulesets.findOne({ rulesetId: rulesetId })
  validity = Joi.validate(entry ? entry.ruleset : ledgerPublisher.ruleset, ledgerPublisher.schema)
  if (validity.error) throw new Error(validity.error)

  ledgerPublisher.getRules(function (err, rules) {
    var validity

    if (err) runtime.newrelic.noticeError(err, { ledgerPublisher: 'getRules' })
    if ((!rules) || (underscore.isEqual(ledgerPublisher.ruleset, rules))) return

    validity = Joi.validate(rules, ledgerPublisher.schema)
    if (validity.error) return runtime.newrelic.noticeError(new Error(validity.error), { ledgerPublisher: 'getRules' })

    ledgerPublisher.ruleset = rules
  })

  await runtime.queue.create('publisher-report')
  runtime.queue.listen('publisher-report',
    runtime.newrelic.createBackgroundTransaction('publisher-report', async function (err, debug, payload) {
/* sent when the publisher status updates

    { queue            : 'publisher-report'
    , message          :
      { publisher      : '...'
      , verified       : true
      }
    }
 */

      var report

      if (err) return debug('publisher-report listen', err)

      report = async function () {
        var state, tld
        var publisher = payload.publisher
        var verified = payload.verified
        var publishers = runtime.db.get('publishers', debug)

        try {
          tld = tldjs.getPublicSuffix(publisher)
        } catch (ex) {
          debug('publisher-report', { payload: payload, err: ex, stack: ex.stack })
        }
        if (!tld) return debug('publisher-report', 'invalid publisher domain: ' + publisher)

        state = { $currentDate: { timestamp: { $type: 'timestamp' } },
                  $set: { verified: verified, tld: tld }
                }
        await publishers.update({ publisher: publisher }, state, { upsert: true })
      }

      try { await report() } catch (ex) {
        debug('publisher-report', { payload: payload, err: ex, stack: ex.stack })
        runtime.newrelic.noticeError(ex, payload)
      }
      runtime.newrelic.endTransaction()
    })
  )
}
