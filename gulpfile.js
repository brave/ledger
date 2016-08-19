var gulp = require('gulp')
var del = require('del')
var nodemon = require('gulp-nodemon')
var runSequence = require('run-sequence')
var standard = require('gulp-standard')

var SRC = [
  'gulpfile.js',
  'rsmq-clear.js',
  'src/**/[A-Za-z]*.js',
  'src/controllers/**/[A-Za-z]*.js',
  'test/**/[A-Za-z]*.js'
]

/**
 * Runs travis tests and the pre-commit hook.
 */
var failOnLint = false
gulp.task('angry-lint', function (cb) {
  failOnLint = true
  runSequence(['lint'], cb)
})

gulp.task('run', function () {
  nodemon({
    script: 'src/index.js',
    ext: 'js',
    env: { 'DEBUG': '*' },
    execMap: {
      js: './node_modules/.bin/babel-node'
    },
    watch: SRC
  }).on('change', ['lint', 'run'])
    .on('restart', function () {
      console.log('restarted!')
    })
})

/**
 * Runs linters on all javascript files found in the src dir.
 */
gulp.task('lint', function () {
  // Note: To have the process exit with an error code (1) on
  // lint error, return the stream and pipe to failOnError last.
  return gulp.src(SRC)
    .pipe(standard())
    .pipe(standard.reporter('default', {
      breakOnError: failOnLint
    }))
})

/**
 * Install pre-commit hook for app.
 */
gulp.task('pre-commit', function () {
  return gulp.src(['./pre-commit'])
    .pipe(gulp.dest('.git/hooks/'))
})

/**
 * The default task when `gulp` is run.
 * Adds a listener which will re-build on a file save.
 */
gulp.task('default', function () {
  runSequence('lint', 'run')
})

/**
 * Cleans all created files by this gulpfile, and node_modules.
 */
gulp.task('clean', function (cb) {
  del([
    'node_modules/'
  ], cb)
})
