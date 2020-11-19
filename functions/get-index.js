'use strict';

const co = require("co");
const Promise = require("bluebird");
const fs = Promise.promisifyAll(require("fs"));
const Mustache = require('mustache');
const http = require('superagent-promise')(require('superagent'), Promise);
const URL = require('url');
const aws4 = require('../lib/aws4');
const log = require('../lib/log');
const cloudwatch = require('../lib/cloudwatch');
const AWSXRay = require('aws-xray-sdk');

const middy = require('middy');
const sampleLogging = require('../middleware/sample-logging');

const awsRegion = process.env.AWS_REGION;
const cognitoUserPoolId = process.env.cognito_user_pool_id;
const cognitoClientId = process.env.cognito_client_id;
const restaurantsApiRoot = process.env.restaurants_api;
const ordersApiRoot = process.env.orders_api;

const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

var html;

function* loadHtml() {
  if (!html) {
    html = yield fs.readFileAsync('static/index.html', 'utf-8');
  }

  return html;
}

function* getRestaurants() {
  let url = URL.parse(restaurantsApiRoot);
  let opts = {
    host: url.hostname,
    path: url.pathname
  };

  aws4.sign(opts);

  let httpReq = http
    .get(restaurantsApiRoot)
    .set('Host', opts.headers['Host'])
    .set('X-Amz-Date', opts.headers['X-Amz-Date'])
    .set('Authorization', opts.headers['Authorization']);

  if (opts.headers['X-Amz-Security-Token']) {
    httpReq.set('X-Amz-Security-Token', opts.headers['X-Amz-Security-Token']);
  }

  return new Promise((resolve, reject) => {
    let f = co.wrap(function* (subsegment) {
      subsegment.addMetadata('url', restaurantsApiRoot);

      try {
        let body = (yield httpReq).body;
        subsegment.close();
        resolve(body);
      } catch (err) {
        subsegment.close(err);
        reject(err);
      }
    });

    // the current sub/segment
    let segment = AWSXRay.getSegment();

    AWSXRay.captureAsyncFunc("getting restaurants", f, segment);
  });
}

const handler = co.wrap(function* (event, context, callback) {
  yield aws4.init();

  let template = yield loadHtml();
  log.debug("loaded HTML template");

  let restaurants = yield cloudwatch.trackExecTime(
    "GetRestaurantsLatency",
    () => getRestaurants()
  );
  log.debug(`loaded ${restaurants.length} restaurants`);

  let dayOfWeek = days[new Date().getDay()];
  let view = {
    dayOfWeek,
    restaurants,
    awsRegion,
    cognitoUserPoolId,
    cognitoClientId,
    searchUrl: `${restaurantsApiRoot}/search`,
    placeOrderUrl: `${ordersApiRoot}`
  };
  let html = Mustache.render(template, view);
  log.debug(`rendered HTML [${html.length} bytes]`);

  cloudwatch.incrCount('RestaurantsReturned', restaurants.length);

  const response = {
    statusCode: 200,
    body: html,
    headers: {
      'content-type': 'text/html; charset=UTF-8'
    }
  };

  callback(null, response);
});

module.exports.handler = middy(handler)
  .use(sampleLogging({ sampleRate: 0.01 }));