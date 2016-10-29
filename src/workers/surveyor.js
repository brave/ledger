var moment = require('moment')
var underscore = require('underscore')
var utilities = require('../controllers/surveyor.js')

var exports = {}

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

    validity = utilities.validate(surveyorType, entry.payload)
    if (validity.error) return debug('daily', 'unable to create surveyorType=' + surveyorType + ': ' + validity.error)

    payload = utilities.enumerate(runtime, surveyorType, entry.payload)
    if (!payload) return debug('daily', 'no available currencies' + JSON.stringify(entry.payload))

    surveyor = await utilities.create(debug, runtime, surveyorType, payload)
    if (!surveyor) return debug('daily', 'unable to create surveyorType=' + surveyorType)

    debug('daily', 'created ' + surveyorType + ' surveyorID=' + surveyor.surveyorId)
  })

  tomorrow = new Date(now)
  tomorrow.setHours(24, 0, 0, 0)
  setTimeout(function () { daily(debug, runtime) }, tomorrow - now)
  debug('daily', 'running again ' + moment(tomorrow).fromNow())
}

exports.initialize = async function (debug, runtime) {
  if ((typeof process.env.DYNO === 'undefined') || (process.env.DYNO === 'worker.1')) {
    setTimeout(function () { daily(debug, runtime) }, 5 * 1000)
  }
}

exports.workers = {
}

module.exports = exports
