(function() {
  var JS_WS_CLIENT_TYPE = "js-websocket";
  var JS_WS_CLIENT_VERSION = "0.0.1";
  var SYS_CACHE_STORAGE_KEY = "pomelo-cache-key";
  var sysCache = {};

  var Protocol = require("protocol");
  var Package = Protocol.Package;
  var Message = Protocol.Message;
  var EventEmitter = require("emitter");

  if (typeof window != "undefined" && typeof sys != "undefined" && sys.localStorage) {
    window.localStorage = sys.localStorage;
  }

  var RES_OK = 200;
  var RES_FAIL = 500;
  var RES_OLD_CLIENT = 501;

  if (typeof Object.create !== "function") {
    Object.create = function(o) {
      function F() {}
      F.prototype = o;
      return new F();
    };
  }

  var root = window;
  var pomelo = Object.create(EventEmitter.prototype); // object extend from object
  root.pomelo = pomelo;
  var socket = null;
  var reqId = 0;
  var callbacks = {};
  var handlers = {};
  //Map from request id to route
  var routeMap = {};

  var heartbeatInterval = 0;
  var heartbeatTimeout = 0;
  var nextHeartbeatTimeout = 0;
  var gapThreshold = 100; // heartbeat gap threashold
  var heartbeatId = null;
  var heartbeatTimeoutId = null;

  var handshakeCallback = null;

  var decode = null;
  var encode = null;

  var useCrypto;

  var handshakeBuffer = {
    sys: {
      type: JS_WS_CLIENT_TYPE,
      version: JS_WS_CLIENT_VERSION
    },
    user: {}
  };

  var initCallback = null;

  pomelo.init = function(params, cb) {
    initCallback = cb;
    var host = params.host;
    var port = params.port;

    var url = "ws://" + host;
    // var url = host;
    if (port) {
      url += ":" + port;
    }
    cc.log("[Pomelo] init:", params);
    if (cc.sys.localStorage.getItem(SYS_CACHE_STORAGE_KEY)) {
      sysCache = JSON.parse(cc.sys.localStorage.getItem(SYS_CACHE_STORAGE_KEY));
    } else {
      sysCache = {};
    }
    // cc.log("本地读取的：" ,sysCache);
    handshakeBuffer.sys.dictVersion = sysCache.dictVersion || 0;
    handshakeBuffer.sys.protoVersion = sysCache.protoVersion || 0;
    handshakeBuffer.user = params.user;
    handshakeCallback = params.handshakeCallback;
    cc.log("发送的握手：", handshakeBuffer);
    initWebSocket(url, cb);
  };

  var initWebSocket = function(url, cb) {
    var onopen = function(event) {
      var obj = Package.encode(Package.TYPE_HANDSHAKE, Protocol.strencode(JSON.stringify(handshakeBuffer)));
      send(obj);
    };
    var onmessage = function(event) {
      processPackage(Package.decode(event.data), cb);
      // new package arrived, update the heartbeat timeout
      if (heartbeatTimeout) {
        nextHeartbeatTimeout = Date.now() + heartbeatTimeout;
      }
    };
    var onerror = function(event) {
      pomelo.emit("io-error", event);
      cc.error("socket error: ", event);
    };
    var onclose = function(event) {
      pomelo.emit("close", event);
      pomelo.emit("disconnect", event);
      cc.error("socket close: ", event);
    };
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.onopen = onopen;
    socket.onmessage = onmessage;
    socket.onerror = onerror;
    socket.onclose = onclose;
  };

  pomelo.disconnect = function() {
    if (socket) {
      if (socket.disconnect) socket.disconnect();
      if (socket.close) socket.close();
      cc.log("disconnect");
      socket = null;
    }

    if (heartbeatId) {
      clearTimeout(heartbeatId);
      heartbeatId = null;
    }
    if (heartbeatTimeoutId) {
      clearTimeout(heartbeatTimeoutId);
      heartbeatTimeoutId = null;
    }
  };

  pomelo.request = function(route, msg, cb) {
    if (arguments.length === 2 && typeof msg === "function") {
      cb = msg;
      msg = {};
    } else {
      msg = msg || {};
    }
    route = route || msg.route;
    if (!route) {
      return;
    }

    reqId++;
    sendMessage(reqId, route, msg);

    callbacks[reqId] = cb;
    routeMap[reqId] = route;
  };

  pomelo.notify = function(route, msg) {
    msg = msg || {};
    sendMessage(0, route, msg);
  };

  var sendMessage = function(reqId, route, msg) {
    var type = reqId ? Message.TYPE_REQUEST : Message.TYPE_NOTIFY;

    //compress message by protobuf
    var protos = !!pomelo.data.protos ? pomelo.data.protos.client : {};
    if (!!protos[route]) {
      msg = protobuf.encode(route, msg);
    } else {
      msg = Protocol.strencode(JSON.stringify(msg));
    }

    var compressRoute = 0;
    if (pomelo.data.dict && pomelo.data.dict[route]) {
      route = pomelo.data.dict[route];
      compressRoute = 1;
    }

    msg = Message.encode(reqId, type, compressRoute, route, msg);
    var packet = Package.encode(Package.TYPE_DATA, msg);
    send(packet);
  };

  var send = function(packet) {
    //     0 ：对应常量CONNECTING(numeric value 0) ，
    //     正在建立连接连接，还没有完成。The connection has not yet been established.
    // 1 ：对应常量OPEN(numeric value 1) ，
    //     连接成功建立，可以进行通信。The WebSocket connection is established and communication is possible.
    // 2 ：对应常量CLOSING(numeric value 2)
    //     连接正在进行关闭握手，即将关闭。The connection is going through the closing handshake.
    // 3 : 对应常量CLOSED(numeric value 3)
    //     连接已经关闭或者根本没有建立。The connection has been closed or could not be opened.

    if(socket){
    // 默认socket没有readystate也要发送
    if (socket.readystate && socket.readystate != 1) {
      cc.warn("socket.readystate != 1  ", socket);
    } else {
      socket.send(packet.buffer);
    }}else{
      cc.warn("socket == null");
    }
  };

  var handler = {};

  var heartbeat = function(data) {
    if (!heartbeatInterval) {
      // no heartbeat
      return;
    }

    var obj = Package.encode(Package.TYPE_HEARTBEAT);
    if (heartbeatTimeoutId) {
      clearTimeout(heartbeatTimeoutId);
      heartbeatTimeoutId = null;
    }

    if (heartbeatId) {
      // already in a heartbeat interval
      return;
    }

    heartbeatId = setTimeout(function() {
      heartbeatId = null;
      send(obj);
      cc.log("send heartbeat");

      nextHeartbeatTimeout = Date.now() + heartbeatTimeout;
      heartbeatTimeoutId = setTimeout(heartbeatTimeoutCb, heartbeatTimeout);
    }, heartbeatInterval);
  };

  var heartbeatTimeoutCb = function() {
    var gap = nextHeartbeatTimeout - Date.now();
    if (gap > gapThreshold) {
      heartbeatTimeoutId = setTimeout(heartbeatTimeoutCb, gap);
    } else {
      cc.error("server heartbeat timeout");
      pomelo.emit("heartbeat timeout");
      pomelo.disconnect();
    }
  };

  var handshake = function(data) {
    data = JSON.parse(Protocol.strdecode(data));
    if (data.code === RES_OLD_CLIENT) {
      pomelo.emit("error", "client version not fullfill");
      return;
    }

    if (data.code !== RES_OK) {
      pomelo.emit("error", "handshake fail");
      return;
    }

    handshakeInit(data);

    var obj = Package.encode(Package.TYPE_HANDSHAKE_ACK);
    send(obj);
    if (initCallback) {
      initCallback(socket);
      initCallback = null;
    }
  };

  var onData = function(data) {
    //probuff decode
    var msg = Message.decode(data);

    if (msg.id > 0) {
      msg.route = routeMap[msg.id];
      delete routeMap[msg.id];
      if (!msg.route) {
        return;
      }
    }

    msg.body = deCompose(msg);

    processMessage(pomelo, msg);
  };

  var onKick = function(data) {
    data = JSON.parse(Protocol.strdecode(data));
    pomelo.emit("onKick", data);
  };

  handlers[Package.TYPE_HANDSHAKE] = handshake;
  handlers[Package.TYPE_HEARTBEAT] = heartbeat;
  handlers[Package.TYPE_DATA] = onData;  var JS_WS_CLIENT_TYPE = "js-websocket";
    var JS_WS_CLIENT_VERSION = "0.0.1";
    var SYS_CACHE_STORAGE_KEY = "pomelo-cache-key";
    var sysCache = {};

    var Protocol = require("protocol");
    var Package = Protocol.Package;
    var Message = Protocol.Message;
    var EventEmitter = require("emitter");

    if (typeof window != "undefined" && typeof sys != "undefined" && sys.localStorage) {
        window.localStorage = sys.localStorage;
    }

    var RES_OK = 200;
    var RES_FAIL = 500;
    var RES_OLD_CLIENT = 501;

    if (typeof Object.create !== "function") {
        Object.create = function(o) {
            function F() {}
            F.prototype = o;
            return new F();
        };
    }

    var root = window;
    var pomelo = Object.create(EventEmitter.prototype); // object extend from object
    root.pomelo = pomelo;
    var socket = null;
    var reqId = 0;
    var callbacks = {};
    var handlers = {};
    //Map from request id to route
    var routeMap = {};

    var heartbeatInterval = 0;
    var heartbeatTimeout = 0;
    var nextHeartbeatTimeout = 0;
    var gapThreshold = 100; // heartbeat gap threashold
    var heartbeatId = null;
    var heartbeatTimeoutId = null;

    var handshakeCallback = null;

    var decode = null;
    var encode = null;

    var useCrypto;

    var handshakeBuffer = {
        sys: {
            type: JS_WS_CLIENT_TYPE,
            version: JS_WS_CLIENT_VERSION
        },
        user: {}
    };

    var initCallback = null;

    pomelo.init = function(params, cb) {
        initCallback = cb;
        var host = params.host;
        var port = params.port;

        var url = "ws://" + host;
        // var url = host;
        if (port) {
            url += ":" + port;
        }
        cc.log("[Pomelo] init:", params);
        if (cc.sys.localStorage.getItem(SYS_CACHE_STORAGE_KEY)) {
            sysCache = JSON.parse(cc.sys.localStorage.getItem(SYS_CACHE_STORAGE_KEY));
        } else {
            sysCache = {};
        }
        // cc.log("本地读取的：" ,sysCache);
        handshakeBuffer.sys.dictVersion = sysCache.dictVersion || 0;
        handshakeBuffer.sys.protoVersion = sysCache.protoVersion || 0;
        handshakeBuffer.user = params.user;
        handshakeCallback = params.handshakeCallback;
        cc.log("发送的握手：", handshakeBuffer);
        initWebSocket(url, cb);
    };

    var initWebSocket = function(url, cb) {
        var onopen = function(event) {
            var obj = Package.encode(Package.TYPE_HANDSHAKE, Protocol.strencode(JSON.stringify(handshakeBuffer)));
            send(obj);
        };
        var onmessage = function(event) {
            processPackage(Package.decode(event.data), cb);
            // new package arrived, update the heartbeat timeout
            if (heartbeatTimeout) {
                nextHeartbeatTimeout = Date.now() + heartbeatTimeout;
            }
        };
        var onerror = function(event) {
            pomelo.emit("io-error", event);
            cc.error("socket error: ", event);
        };
        var onclose = function(event) {
            pomelo.emit("close", event);
            pomelo.emit("disconnect", event);
            cc.error("socket close: ", event);
        };
        socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        socket.onopen = onopen;
        socket.onmessage = onmessage;
        socket.onerror = onerror;
        socket.onclose = onclose;
    };

    pomelo.disconnect = function() {
        if (socket) {
            if (socket.disconnect) socket.disconnect();
            if (socket.close) socket.close();
            cc.log("disconnect");
            socket = null;
        }

        if (heartbeatId) {
            clearTimeout(heartbeatId);
            heartbeatId = null;
        }
        if (heartbeatTimeoutId) {
            clearTimeout(heartbeatTimeoutId);
            heartbeatTimeoutId = null;
        }
    };

    pomelo.request = function(route, msg, cb) {
        if (arguments.length === 2 && typeof msg === "function") {
            cb = msg;
            msg = {};
        } else {
            msg = msg || {};
        }
        route = route || msg.route;
        if (!route) {
            return;
        }

        reqId++;
        sendMessage(reqId, route, msg);

        callbacks[reqId] = cb;
        routeMap[reqId] = route;
    };

    pomelo.notify = function(route, msg) {
        msg = msg || {};
        sendMessage(0, route, msg);
    };

    var sendMessage = function(reqId, route, msg) {
        var type = reqId ? Message.TYPE_REQUEST : Message.TYPE_NOTIFY;

        //compress message by protobuf
        var protos = !!pomelo.data.protos ? pomelo.data.protos.client : {};
        if (!!protos[route]) {
            msg = protobuf.encode(route, msg);
        } else {
            msg = Protocol.strencode(JSON.stringify(msg));
        }

        var compressRoute = 0;
        if (pomelo.data.dict && pomelo.data.dict[route]) {
            route = pomelo.data.dict[route];
            compressRoute = 1;
        }

        msg = Message.encode(reqId, type, compressRoute, route, msg);
        var packet = Package.encode(Package.TYPE_DATA, msg);
        send(packet);
    };

    var send = function(packet) {
        //     0 ：对应常量CONNECTING(numeric value 0) ，
        //     正在建立连接连接，还没有完成。The connection has not yet been established.
        // 1 ：对应常量OPEN(numeric value 1) ，
        //     连接成功建立，可以进行通信。The WebSocket connection is established and communication is possible.
        // 2 ：对应常量CLOSING(numeric value 2)
        //     连接正在进行关闭握手，即将关闭。The connection is going through the closing handshake.
        // 3 : 对应常量CLOSED(numeric value 3)
        //     连接已经关闭或者根本没有建立。The connection has been closed or could not be opened.

        if(socket){
            // 默认socket没有readystate也要发送
            if (socket.readystate && socket.readystate != 1) {
                cc.warn("socket.readystate != 1  ", socket);
            } else {
                socket.send(packet.buffer);
            }}else{
            cc.warn("socket == null");
        }
    };

    var handler = {};

    var heartbeat = function(data) {
        if (!heartbeatInterval) {
            // no heartbeat
            return;
        }

        var obj = Package.encode(Package.TYPE_HEARTBEAT);
        if (heartbeatTimeoutId) {
            clearTimeout(heartbeatTimeoutId);
            heartbeatTimeoutId = null;
        }

        if (heartbeatId) {
            // already in a heartbeat interval
            return;
        }

        heartbeatId = setTimeout(function() {
            heartbeatId = null;
            send(obj);
            cc.log("send heartbeat");

            nextHeartbeatTimeout = Date.now() + heartbeatTimeout;
            heartbeatTimeoutId = setTimeout(heartbeatTimeoutCb, heartbeatTimeout);
        }, heartbeatInterval);
    };

    var heartbeatTimeoutCb = function() {
        var gap = nextHeartbeatTimeout - Date.now();
        if (gap > gapThreshold) {
            heartbeatTimeoutId = setTimeout(heartbeatTimeoutCb, gap);
        } else {
            cc.error("server heartbeat timeout");
            pomelo.emit("heartbeat timeout");
            pomelo.disconnect();
        }
    };

    var handshake = function(data) {
        data = JSON.parse(Protocol.strdecode(data));
        if (data.code === RES_OLD_CLIENT) {
            pomelo.emit("error", "client version not fullfill");
            return;
        }

        if (data.code !== RES_OK) {
            pomelo.emit("error", "handshake fail");
            return;
        }

        handshakeInit(data);

        var obj = Package.encode(Package.TYPE_HANDSHAKE_ACK);
        send(obj);
        if (initCallback) {
            initCallback(socket);
            initCallback = null;
        }
    };

    var onData = function(data) {
        //probuff decode
        var msg = Message.decode(data);

        if (msg.id > 0) {
            msg.route = routeMap[msg.id];
            delete routeMap[msg.id];
            if (!msg.route) {
                return;
            }
        }

        msg.body = deCompose(msg);

        processMessage(pomelo, msg);
    };

    var onKick = function(data) {
        data = JSON.parse(Protocol.strdecode(data));
        pomelo.emit("onKick", data);
    };

    handlers[Package.TYPE_HANDSHAKE] = handshake;
    handlers[Package.TYPE_HEARTBEAT] = heartbeat;
    handlers[Package.TYPE_DATA] = onData;
    handlers[Package.TYPE_KICK] = onKick;

    var processPackage = function(msgs) {
        if (Array.isArray(msgs)) {
            for (var i = 0; i < msgs.length; i++) {
                var msg = msgs[i];
                handlers[msg.type](msg.body);
            }
        } else {
            handlers[msgs.type](msgs.body);
        }
    };

    var processMessage = function(pomelo, msg) {
        if (!msg.id) {
            // server push message
            pomelo.emit(msg.route, msg.body);
        }

        //if have a id then find the callback function with the request
        var cb = callbacks[msg.id];

        delete callbacks[msg.id];
        if (typeof cb !== "function") {
            return;
        }

        cb(msg.body);
        return;
    };

    var processMessageBatch = function(pomelo, msgs) {
        for (var i = 0, l = msgs.length; i < l; i++) {
            processMessage(pomelo, msgs[i]);
        }
    };

    var deCompose = function(msg) {
        var protos = !!pomelo.data.protos ? pomelo.data.protos.server : {};
        var abbrs = pomelo.data.abbrs;
        var route = msg.route;

        //Decompose route from dict
        if (msg.compressRoute) {
            if (!abbrs[route]) {
                return {};
            }

            route = msg.route = abbrs[route];
        }
        if (!!protos[route]) {
            return protobuf.decode(route, msg.body);
        } else {
            return JSON.parse(Protocol.strdecode(msg.body));
        }

        return msg;
    };

    var handshakeInit = function(data) {
        if (data.sys && data.sys.heartbeat) {
            heartbeatInterval = data.sys.heartbeat * 1000; // heartbeat interval
            heartbeatTimeout = heartbeatInterval * 2; // max heartbeat timeout
        } else {
            heartbeatInterval = 0;
            heartbeatTimeout = 0;
        }

        initData(data);

        if (typeof handshakeCallback === "function") {
            handshakeCallback(data.user);
        }
    };

    //Initilize data used in pomelo client
    var initData = function(data) {
        if (!data || !data.sys) {
            return;
        }
        pomelo.data = pomelo.data || {};

        var dict = data.sys.useDict ? data.sys.dict || sysCache.dict : null;
        var protos = data.sys.useProto ? data.sys.protos || sysCache.protos : null;

        var dictVersion = data.sys.dictVersion;
        var protoVersion = data.sys.protos ? data.sys.protos.version : null;

        var change = false;
        if (dictVersion != null) {
            sysCache["dict"] = dict;
            sysCache["dictVersion"] = dictVersion;
            change = true;
        }
        if (protoVersion != null) {
            sysCache["protos"] = protos;
            sysCache["protoVersion"] = protoVersion;
            change = true;
        }
        // cc.log("本地存储：" ,sysCache);
        if (change) {
            cc.sys.localStorage.setItem(SYS_CACHE_STORAGE_KEY, JSON.stringify(sysCache));
        }

        //Init compress dict
        if (dict) {
            pomelo.data.dict = dict;
            pomelo.data.abbrs = {};

            for (var route in dict) {
                pomelo.data.abbrs[dict[route]] = route;
            }
        }

        //Init protobuf protos
        if (protos) {
            pomelo.data.protos = {
                server: protos.server || {},
                client: protos.client || {}
            };
            if (!!protobuf) {
                protobuf.init({
                    encoderProtos: protos.client,
                    decoderProtos: protos.server
                });
            }
        }
    };

    module.exports = pomelo;

    handlers[Package.TYPE_KICK] = onKick;

  var processPackage = function(msgs) {
    if (Array.isArray(msgs)) {
      for (var i = 0; i < msgs.length; i++) {
        var msg = msgs[i];
        handlers[msg.type](msg.body);
      }
    } else {
      handlers[msgs.type](msgs.body);
    }
  };

  var processMessage = function(pomelo, msg) {
    if (!msg.id) {
      // server push message
      pomelo.emit(msg.route, msg.body);
    }

    //if have a id then find the callback function with the request
    var cb = callbacks[msg.id];

    delete callbacks[msg.id];
    if (typeof cb !== "function") {
      return;
    }

    cb(msg.body);
    return;
  };

  var processMessageBatch = function(pomelo, msgs) {
    for (var i = 0, l = msgs.length; i < l; i++) {
      processMessage(pomelo, msgs[i]);
    }
  };

  var deCompose = function(msg) {
    var protos = !!pomelo.data.protos ? pomelo.data.protos.server : {};
    var abbrs = pomelo.data.abbrs;
    var route = msg.route;

    //Decompose route from dict
    if (msg.compressRoute) {
      if (!abbrs[route]) {
        return {};
      }

      route = msg.route = abbrs[route];
    }
    if (!!protos[route]) {
      return protobuf.decode(route, msg.body);
    } else {
      return JSON.parse(Protocol.strdecode(msg.body));
    }

    return msg;
  };

  var handshakeInit = function(data) {
    if (data.sys && data.sys.heartbeat) {
      heartbeatInterval = data.sys.heartbeat * 1000; // heartbeat interval
      heartbeatTimeout = heartbeatInterval * 2; // max heartbeat timeout
    } else {
      heartbeatInterval = 0;
      heartbeatTimeout = 0;
    }

    initData(data);

    if (typeof handshakeCallback === "function") {
      handshakeCallback(data.user);
    }
  };

  //Initilize data used in pomelo client
  var initData = function(data) {
    if (!data || !data.sys) {
      return;
    }
    pomelo.data = pomelo.data || {};

    var dict = data.sys.useDict ? data.sys.dict || sysCache.dict : null;
    var protos = data.sys.useProto ? data.sys.protos || sysCache.protos : null;

    var dictVersion = data.sys.dictVersion;
    var protoVersion = data.sys.protos ? data.sys.protos.version : null;

    var change = false;
    if (dictVersion != null) {
      sysCache["dict"] = dict;
      sysCache["dictVersion"] = dictVersion;
      change = true;
    }
    if (protoVersion != null) {
      sysCache["protos"] = protos;
      sysCache["protoVersion"] = protoVersion;
      change = true;
    }
    // cc.log("本地存储：" ,sysCache);
    if (change) {
      cc.sys.localStorage.setItem(SYS_CACHE_STORAGE_KEY, JSON.stringify(sysCache));
    }

    //Init compress dict
    if (dict) {
      pomelo.data.dict = dict;
      pomelo.data.abbrs = {};

      for (var route in dict) {
        pomelo.data.abbrs[dict[route]] = route;
      }
    }

    //Init protobuf protos
    if (protos) {
      pomelo.data.protos = {
        server: protos.server || {},
        client: protos.client || {}
      };
      if (!!protobuf) {
        protobuf.init({
          encoderProtos: protos.client,
          decoderProtos: protos.server
        });
      }
    }
  };

  module.exports = pomelo;
})();
