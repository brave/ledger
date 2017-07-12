var boom = require('boom')
var braveHapi = require('../brave-hapi')
var bson = require('bson')
var Joi = require('joi')
var ledgerPublisher = require('ledger-publisher')
var underscore = require('underscore')
var url = require('url')
var uuid = require('uuid')

var v1 = {}
var v2 = {}

var rulesetId = 1

var rulesetEntry = async (request, runtime) => {
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

var rulesetEntryV2 = async (request, runtime) => {
  var entryV2 = await rulesetEntry(request, runtime)
  var ruleset = []

  entryV2.ruleset.forEach(rule => { if (rule.consequent) ruleset.push(rule) })
  ruleset = [
    { condition: '/^[a-z][a-z].gov$/.test(SLD)',
      consequent: 'QLD + "." + SLD',
      description: 'governmental sites'
    },
    { condition: "TLD === 'gov' || /^go.[a-z][a-z]$/.test(TLD) || /^gov.[a-z][a-z]$/.test(TLD)",
      consequent: 'SLD',
      description: 'governmental sites'
    }
  ].concat(ruleset)
  return { ruleset: ruleset, version: entryV2.version }
}

var publisherV2 = { publisher: Joi.string().required().description('the publisher identity') }

var propertiesV2 =
  {
    facet: Joi.string().valid('domain', 'SLD', 'TLD').optional().default('domain').description('the entry type'),
    exclude: Joi.boolean().optional().default(true).description('exclude from auto-include list'),
    tags: Joi.array().items(Joi.string()).optional().description('taxonomy tags')
  }

var schemaV2 = Joi.object().keys(underscore.extend({}, publisherV2, propertiesV2,
  { timestamp: Joi.string().regex(/^[0-9]+$/).required().description('an opaque, monotonically-increasing value') }
))

/*
   GET /v1/publisher/ruleset
   GET /v2/publisher/ruleset
 */

v1.read =
{ handler: (runtime) => {
  return async (request, reply) => {
    var consequential = request.query.consequential
    var entry = consequential ? (await rulesetEntryV2(request, runtime)) : (await rulesetEntry(request, runtime))

    return reply(entry.ruleset)
  }
},

  description: 'Returns the publisher identity ruleset',
  tags: [ 'api' ],

  validate:
    { query: { consequential: Joi.boolean().optional().default(false).description('return only consequential rules') } },

  response:
    { schema: ledgerPublisher.schema }
}

v2.read =
{ handler: (runtime) => {
  return async (request, reply) => {
    var entries, modifiers, query, result
    var debug = braveHapi.debug(module, request)
    var excludedOnly = request.query.excludedOnly
    var limit = parseInt(request.query.limit, 10)
    var timestamp = request.query.timestamp
    var publishers = runtime.db.get('publishersV2', debug)

    try { timestamp = (timestamp || 0) ? bson.Timestamp.fromString(timestamp) : bson.Timestamp.ZERO } catch (ex) {
      return reply(boom.badRequest('invalid value for the timestamp parameter: ' + timestamp))
    }

    if (isNaN(limit) || (limit > 512)) limit = 512
    query = { timestamp: { $gte: timestamp } }
    modifiers = { sort: { timestamp: 1 } }

    entries = await publishers.find(query, underscore.extend({ limit: limit }, modifiers))
    result = []
    entries.forEach(entry => {
      if ((entry.publisher === '') || (excludedOnly && (entry.exclude !== true))) return

      result.push(underscore.extend(underscore.omit(entry, [ '_id', 'timestamp' ]),
                                    { timestamp: entry.timestamp.toString() }))
    })

    reply(result)
  }
},

  description: 'Returns information about publisher identity ruleset entries',
  tags: [ 'api' ],

  validate: {
    query: {
      timestamp: Joi.string().regex(/^[0-9]+$/).optional().description('an opaque, monotonically-increasing value'),
      limit: Joi.number().positive().optional().description('the maximum number of entries to return'),
      excludedOnly: Joi.boolean().optional().default(true).description('return only excluded sites')
    }
  },

  response:
    { schema: Joi.array().items(schemaV2) }
}

/*
   POST /v2/publisher/ruleset
 */

v2.create =
{ handler: (runtime) => {
  return async (request, reply) => {
    var result
    var debug = braveHapi.debug(module, request)
    var payload = request.payload
    var publisher = payload.publisher
    var publishers = runtime.db.get('publishersV2', debug)

    result = await publishers.findOne({ publisher: publisher })
    if (result) return reply(boom.badData('publisher identity entry already exists: ' + publisher))

    try {
      await publishers.insert(underscore.extend(payload, { timestamp: bson.Timestamp() }))
    } catch (ex) {
      runtime.notify(debug, { text: 'publishers error: ' + ex.toString() })
      debug('publishers error', ex)
      return reply(boom.badData(ex.toString()))
    }

    result = await publishers.findOne({ publisher: publisher })
    if (!result) return reply(boom.badImplementation('database creation failed: ' + publisher))

    result = underscore.extend(underscore.omit(result, [ '_id', 'timestamp' ]), { timestamp: result.timestamp.toString() })

    reply(result)
  }
},

  auth: {
    strategy: 'session',
    scope: [ 'ledger' ],
    mode: 'required'
  },

  description: 'Defines information a new publisher identity ruleset entry',
  tags: [ 'api' ],

  validate:
    { payload: underscore.extend({}, publisherV2, propertiesV2) },

  response:
    { schema: schemaV2 }
}

/*
   PATCH /v2/publisher/rulesets
 */

v2.update =
{ handler: (runtime) => {
  return async (request, reply) => {
    var authority = request.auth.credentials.provider + ':' + request.auth.credentials.profile.username
    var reportId = uuid.v4().toLowerCase()
    var reportURL = url.format(underscore.defaults({ pathname: '/v1/reports/file/' + reportId }, runtime.config.server))
    var debug = braveHapi.debug(module, request)

    await runtime.queue.send(debug, 'patch-publisher-rulesets',
                             underscore.defaults({ reportId: reportId, reportURL: reportURL, authority: authority },
                                                 { entries: request.payload }))
    reply({ reportURL: reportURL })
  }
},

  auth: {
    strategy: 'session',
    scope: [ 'devops' ],
    mode: 'required'
  },

  description: 'Batched update of publisher identity ruleset entries',
  tags: [ 'api' ],

  validate:
    { payload: Joi.array().items(Joi.object().keys(underscore.extend(publisherV2, propertiesV2))).required() },

  response: {
    schema: Joi.object().keys({
      reportURL: Joi.string().uri({ scheme: /https?/ }).optional().description('the URL for a forthcoming report')
    }).unknown(true)
  }
}

/*
   PUT /v2/publisher/ruleset/{publisher}
 */

v2.write =
{ handler: (runtime) => {
  return async (request, reply) => {
    var result, state
    var debug = braveHapi.debug(module, request)
    var publisher = request.params.publisher
    var publishers = runtime.db.get('publishersV2', debug)

    state = { $currentDate: { timestamp: { $type: 'timestamp' } }, $set: request.payload }
    await publishers.update({ publisher: publisher }, state, { upsert: true })

    result = await publishers.findOne({ publisher: publisher })
    if (!result) return reply(boom.badImplementation('database update failed: ' + publisher))

    result = underscore.extend(underscore.omit(result, [ '_id', 'timestamp' ]), { timestamp: result.timestamp.toString() })

    reply(result)
  }
},

  auth: {
    strategy: 'session',
    scope: [ 'devops' ],
    mode: 'required'
  },

  description: 'Sets information for a publisher identity ruleset entry',
  tags: [ 'api' ],

  validate: {
    params: publisherV2,
    payload: Joi.object().keys(propertiesV2)
  },

  response:
    { schema: schemaV2 }
}

/*
   DELETE /v2/publisher/ruleset/{publisher}
 */

v2.delete =
{ handler: (runtime) => {
  return async (request, reply) => {
    var entry
    var debug = braveHapi.debug(module, request)
    var publisher = request.params.publisher
    var publishers = runtime.db.get('publishersV2', debug)

    entry = await publishers.findOne({ publisher: publisher })
    if (!entry) return reply(boom.notFound('no such entry: ' + publisher))

    await publishers.remove({ publisher: publisher })

    reply().code(204)
  }
},

  auth: {
    strategy: 'session',
    scope: [ 'ledger' ],
    mode: 'required'
  },

  description: 'Deletes information a publisher identity ruleset entry',
  tags: [ 'api' ],

  validate:
    { params: publisherV2 },

  response:
    { schema: Joi.any() }
}

/*
   GET /v1/publisher/ruleset/version
 */

v1.version =
{ handler: (runtime) => {
  return async (request, reply) => {
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
   GET /v2/publisher/identity?url=...
 */

v1.identity =
{ handler: (runtime) => {
  return async (request, reply) => {
    var result
    var url = request.query.url

    try {
      result = ledgerPublisher.getPublisherProps(url)
      if (result) result.publisher = ledgerPublisher.getPublisher(url)

      reply(result || boom.notFound())
    } catch (ex) {
      reply(boom.badData(ex.toString()))
    }
  }
},

  description: 'Returns the publisher identity associated with a URL',
  tags: [ 'api', 'deprecated' ],

  validate:
    { query: { url: Joi.string().uri({ scheme: /https?/ }).required().description('the URL to parse') } },

  response:
    { schema: Joi.object().optional().description('the publisher identity') }
}

v2.identity =
{ handler: (runtime) => {
  return async (request, reply) => {
    var result
    var entry = await rulesetEntryV2(request, runtime)
    var url = request.query.url
    var debug = braveHapi.debug(module, request)
    var publishers = runtime.db.get('publishersV2', debug)

    var re = (value, entries) => {
      entries.forEach((reEntry) => {
        var regexp

        if ((entry) ||
            (underscore.intersection(reEntry.publisher.split(''),
                                  [ '^', '$', '*', '+', '?', '[', '(', '{', '|' ]).length === 0)) return

        try {
          regexp = new RegExp(reEntry.publisher)
          if (regexp.test(value)) entry = reEntry
        } catch (ex) {
          debug('invalid regexp ' + reEntry.publisher + ': ' + ex.toString())
        }
      })
    }

    try {
      result = ledgerPublisher.getPublisherProps(url)
      if (!result) return reply(boom.notFound())

      result.publisher = ledgerPublisher.getPublisher(url, entry.ruleset)
      if (result.publisher) {
        entry = await publishers.findOne({ publisher: result.publisher, facet: 'domain' })

        if (!entry) entry = await publishers.findOne({ publisher: result.SLD.split('.')[0], facet: 'SLD' })
        if (!entry) re(result.SLD, await publishers.find({ facet: 'SLD' }))

        if (!entry) entry = await publishers.findOne({ publisher: result.TLD, facet: 'TLD' })
        if (!entry) re(result.TLD, await publishers.find({ facet: 'TLD' }))

        if (entry) {
          result.properties = underscore.omit(entry, [ '_id', 'publisher', 'timestamp' ])
          result.timestamp = entry.timestamp.toString()
        }
      }

      reply(result)
    } catch (ex) {
      reply(boom.badData(ex.toString()))
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
   GET /v1/publisher/identity/verified
   GET /v2/publisher/identity/verified
 */

v1.verified =
{ handler: (runtime) => {
  return async (request, reply) => {
    var entries, result
    var limit = request.query.limit
    var tld = request.query.tld || { $exists: true }
    var debug = braveHapi.debug(module, request)
    var publishers = runtime.db.get('publishers', debug)

    entries = await publishers.find({ verified: true, tld: tld }, { fields: { publisher: 1 }, limit: limit })
    result = []
    entries.forEach((entry) => { result.push(entry.publisher) })
    reply(result)
  }
},

  description: 'Returns a list of verified publishers',
  tags: [ 'api', 'deprecated' ],

  validate: {
    query: {
      limit: Joi.number().integer().positive().default(500).description('maximum number of matches'),
      tld: Joi.string().hostname().optional().description('a suffix-matching string')
    }
  },

  response:
    { schema: Joi.array().items(Joi.string()).description('verified publishers') }
}

v2.verified =
{ handler: (runtime) => {
  return async (request, reply) => {
    var entries, modifiers, query, result
    var debug = braveHapi.debug(module, request)
    var limit = parseInt(request.query.limit, 10)
    var timestamp = request.query.timestamp
    var tld = request.query.tld || { $exists: true }
    var publishers = runtime.db.get('publishers', debug)

    try { timestamp = (timestamp || 0) ? bson.Timestamp.fromString(timestamp) : bson.Timestamp.ZERO } catch (ex) {
      return reply(boom.badRequest('invalid value for the timestamp parameter: ' + timestamp))
    }

    if (isNaN(limit) || (limit > 512)) limit = 512
    query = { timestamp: { $gte: timestamp }, tld: tld }
    modifiers = { sort: { timestamp: 1 } }

    entries = await publishers.find(query, underscore.extend({ limit: limit }, modifiers))
    result = []
    entries.forEach(entry => {
      if (entry.publisher === '') return

      result.push(underscore.extend(underscore.omit(entry, [ '_id', 'timestamp' ]),
                                    { timestamp: entry.timestamp.toString() }))
    })

    reply(result)
  }
},

  description: 'Returns information about publisher verification entries',
  tags: [ 'api' ],

  validate: {
    query: {
      timestamp: Joi.string().regex(/^[0-9]+$/).optional().description('an opaque, monotonically-increasing value'),
      limit: Joi.number().positive().optional().description('the maximum number of entries to return'),
      tld: Joi.string().hostname().optional().description('a suffix-matching string')
    }
  },

  response: {
    schema: Joi.array().items(Joi.object().keys({
      publisher: Joi.string().required().description('the publisher identity'),
      verified: Joi.boolean().required().description('verification status'),
      tld: Joi.string().required().description('top-level domain'),
      timestamp: Joi.string().regex(/^[0-9]+$/).required().description('an opaque, monotonically-increasing value')
    }).unknown(true))
  }
}

module.exports.routes = [
  braveHapi.routes.async().get().path('/v1/publisher/ruleset').config(v1.read),
  braveHapi.routes.async().get().path('/v1/publisher/ruleset/version').config(v1.version),
  braveHapi.routes.async().get().path('/v1/publisher/identity').config(v1.identity),

  braveHapi.routes.async().get().path('/v2/publisher/ruleset').config(v2.read),
  braveHapi.routes.async().post().path('/v2/publisher/ruleset').config(v2.create),
  braveHapi.routes.async().patch().path('/v2/publisher/rulesets').config(v2.update),
  braveHapi.routes.async().put().path('/v2/publisher/ruleset/{publisher}').config(v2.write),
  braveHapi.routes.async().delete().path('/v2/publisher/ruleset/{publisher}').config(v2.delete),
  braveHapi.routes.async().get().path('/v2/publisher/identity').config(v2.identity),

  braveHapi.routes.async().get().path('/v1/publisher/identity/verified').config(v1.verified),
  braveHapi.routes.async().get().path('/v2/publisher/identity/verified').config(v2.verified)
]

module.exports.initialize = async (debug, runtime) => {
  var entry, validity
  var publishers = runtime.db.get('publishersV2', debug)
  var rulesets = runtime.db.get('rulesets', debug)

  runtime.db.checkIndices(debug, [
    {
      category: rulesets,
      name: 'rulesets',
      property: 'rulesetId',
      empty: { rulesetId: 0, type: '', version: '', timestamp: bson.Timestamp.ZERO },
      unique: [ { rulesetId: 1 } ],
      others: [ { type: 1 }, { version: 1 }, { timestamp: 1 } ]
    },
    {
      category: runtime.db.get('publishers', debug),
      name: 'publishers',
      property: 'publisher',
      empty: { publisher: '', tld: '', verified: false, timestamp: bson.Timestamp.ZERO },
      unique: [ { publisher: 1 } ],
      others: [ { tld: 1 }, { verified: 1 }, { timestamp: 1 } ]
    },
    {
      category: publishers,
      name: 'publishersV2',
      property: 'publisher',
      empty: { publisher: '', facet: '', exclude: false, tags: [], timestamp: bson.Timestamp.ZERO },
      unique: [ { publisher: 1 } ],
      others: [ { facet: 1 }, { exclude: 1 }, { timestamp: 1 } ]
    }
  ])

  entry = await rulesets.findOne({ rulesetId: rulesetId })
  validity = Joi.validate(entry ? entry.ruleset : ledgerPublisher.ruleset, ledgerPublisher.schema)
  if (validity.error) throw new Error(validity.error)

  ledgerPublisher.getRules((err, rules) => {
    var validity

    if (err) runtime.newrelic.noticeError(err, { ledgerPublisher: 'getRules' })
    if ((!rules) || (underscore.isEqual(ledgerPublisher.ruleset, rules))) return

    validity = Joi.validate(rules, ledgerPublisher.schema)
    if (validity.error) return runtime.newrelic.noticeError(new Error(validity.error), { ledgerPublisher: 'getRules' })

    ledgerPublisher.ruleset = rules
  })

  await runtime.queue.create('patch-publisher-rulesets')
}
