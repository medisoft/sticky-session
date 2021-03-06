'use strict';

var cluster = require('cluster'),
  util = require('util'),
  net = require('net'),
  ip = require('ip'),
  common = require('_http_common'),
  parsers = common.parsers,
  HTTPParser = process.binding('http_parser').HTTPParser,
  debug = require('debug')('sticky:master');

module.exports = Master;

function Master(options) {
  var self = this;

  if (!(self instanceof Master)) {
    return new Master(options);
  }

  debug('master options = %j', options);

  self.options = options || {};
  self.seed = (Math.random() * 0xffffffff) | 0;
  self.workers = [];

  debug('master seed=%d', self.seed);

  net.Server.call(self, {
    pauseOnConnect: true
  }, options.proxyHeader ? self.balanceProxyAddress : self.balanceRemoteAddress);

  self.once('listening', function () {
    debug('master listening on %j', self.address());

    for (var i = 0; i < options.workers; i++) {
      self.spawnWorker();
    }
  });
}

util.inherits(Master, net.Server);

Master.prototype.hash = function hash(ip) {
  var self = this,
    hash = self.seed;

  for (var i = 0; i < ip.length; i++) {
    var num = ip[i];

    hash += num;
    hash %= 2147483648;
    hash += (hash << 10);
    hash %= 2147483648;
    hash ^= hash >> 6;
  }

  hash += hash << 3;
  hash %= 2147483648;
  hash ^= hash >> 11;
  hash += hash << 15;
  hash %= 2147483648;

  return hash >>> 0;
};

Master.prototype.spawnWorker = function spawnWorker() {
  var self = this,
    worker = cluster.fork(self.options.env || {});

  worker.on('exit', function (code) {
    debug('worker=%d died with code=%d', worker.process.pid, code);
    self.respawn(worker);
  });

  worker.on('message', function (message) {
    // Graceful exit
    if (message.type === 'close') {
      self.respawn(worker);
    }
  });

  debug('worker=%d spawn', worker.process.pid);
  self.workers.push(worker);
};

Master.prototype.respawn = function respawn(worker) {
  var self = this;

  if (self.workers.indexOf(worker) !== -1) {
    self.workers.splice(index, 1);
  }

  self.spawnWorker();
};

Master.prototype.balanceRemoteAddress = function balanceRemoteAddress(socket) {
  var self = this,
    addr = (socket.remoteAddress || '127.0.0.1').split(',').shift().trim(),
    hash = self.hash(ip.toBuffer(addr));

  debug('balancing connection %s', addr);

  self.workers[hash % self.workers.length].send(['sticky:balance'], socket);
};

Master.prototype.balanceProxyAddress = function balanceProxyAddress(socket) {
  var self = this;

  debug('incoming proxy');

  socket.resume();
  socket.once('data', function (buffer) {
    var parser = parsers.alloc();

    parser.reinitialize(HTTPParser.REQUEST);
    parser.onIncoming = function (req) {
      // socket.pause();
      // socket.unshift(buffer);
      var addr = (socket.remoteAddress || '127.0.0.1').split(',').shift().trim(),
        hash;

      if (self.options.proxyHeader && req.headers[self.options.proxyHeader]) {
        addr = req.headers[self.options.proxyHeader].split(',').shift().trim();
      }

      debug('balancing connection %s', addr);

      hash = self.hash(ip.toBuffer(addr));
      self.workers[hash % self.workers.length]
        .send(['sticky:balance', buffer.toString('base64')], socket);
      // .send(['sticky:balance'], socket);
    };
    parser.execute(buffer, 0, buffer.length);
    parser.finish();
  });
};
