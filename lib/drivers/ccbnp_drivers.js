/* jshint node: true */
'use strict';

var ccbnp = require('cc-bnp'),
    _ = require('busyman'),
    Q = require('q');

var GATTDEFS = require('../defs/gattdefs'),
    GAPDEFS = require('../defs/gapdefs');

var ccbnpDrivers = {};

ccbnpDrivers.init = function (spCfg) {
    var deferred = Q.defer();

    ccbnp.init(spCfg, 'central').done(function (result) {
        deferred.resolve(result.addr);
    }, function (err) {
        deferred.reject(err);
    });

    return deferred.promise;
};

ccbnpDrivers.close = function () {
    var deferred = Q.defer();

    this.reset(1).then(function () {
        return ccbnp.close();
    }).done(function () {
        deferred.resolve();
    }, function (err) {
        deferred.reject(err);
    });

    return deferred.promise;
};

ccbnpDrivers.reset = function (mode) {
    if (mode === 0 || mode === 'soft') 
        return ccbnp.hci.resetSystem(0);
    else if (!mode || mode === 1 || mode === 'hard')
        return ccbnp.hci.resetSystem(1);
};

ccbnpDrivers.scan = function () {
    var self = this,
        deferred = Q.defer(),
        periphInfos;

    ccbnp.gap.deviceDiscReq(3, 1, 0).done(function (result) {
        periphInfos = result.collector.GapDeviceDiscovery[0].devs;
        periphInfos = periphInfos || [];
        deferred.resolve(periphInfos);
    },function (err) {
        deferred.reject(err);
    });

    return deferred.promise;
};

ccbnpDrivers.cancelScan = function () {
    return ccbnp.gap.deviceDiscCancel();
};

ccbnpDrivers.setScanParams = function (setting) {
    var time = setting.time || 10240,
        interval = setting.interval || 16,
        windows = setting.window || 16;

    return ccbnp.gap.setParam(2, time).then(function (result) {
        return ccbnp.gap.setParam(16, interval);
    }).then(function (result) {
        return ccbnp.gap.setParam(17, windows);
    });
};

ccbnpDrivers.setLinkParams = function (setting) {
    var interval = setting.interval || 0x0018,
        latency = setting.latency || 0x0000,
        timeout = setting.timeout || 0x00c8;

    return ccbnp.gap.setParam(21, interval).then(function () {
        return ccbnp.gap.setParam(22, interval);
    }).then(function () {
        return ccbnp.gap.setParam(26, latency);
    }).then(function () {
        return ccbnp.gap.setParam(25, timeout);
    });
};

ccbnpDrivers.setBondParam = function (paramId, value) {
    return ccbnp.gap.bondSetParam(paramId, value.length, value);
};

ccbnpDrivers.connect = function (periph) {
    var deferred = Q.defer(),
        addrType;

    addrType = periph.addrType;
    if (!_.isNumber(addrType))
        addrType = addrType === 'random' ? 0x01 : 0x00;
    ccbnp.gap.estLinkReq(1, 0, addrType, periph.addr).done(function (result) {
        deferred.resolve(result.collector.GapLinkEstablished[0].addr);
    }, function (err) {
        if (err.message === 'bleNoResources')
            deferred.reject(new Error('Connection Limit Exceeded'));
        else 
            deferred.reject(err);
    });

    return deferred.promise;
};

ccbnpDrivers.connectCancel = function (periph) {
    var deferred = Q.defer();

    ccbnp.gap.terminateLink(65534, 19).done(function (result) {
        deferred.resolve(result.addr);
    }, function (err) {
        deferred.reject(err);
    });

    return deferred.promise;
};

ccbnpDrivers.disconnect = function (periph) {
    return ccbnp.gap.terminateLink(periph.connHdl, 19);
};

ccbnpDrivers.updateLinkParam = function (periph, setting) {
    var interval = setting.interval,
        latency = setting.latency,
        timeout= setting.timeout;

    return ccbnp.gap.updateLinkParamReq(periph.connHdl, interval, interval, latency, timeout);
};

ccbnpDrivers.discAllServsAndChars = function (periph) {
    var deferred = Q.defer(),
        servs = [],
        discChars = [];

    ccbnp.gatt.discAllPrimaryServices(periph.connHdl).then(function (result) {
        _.forEach(result.collector.AttReadByGrpTypeRsp, function (evtObj) {
            var servObj;

            if (evtObj.status === 0) { 
                servObj = evtObj.data;
                for (var i = 0; i < (_.keys(servObj).length / 3); i += 1) {
                    servs.push({
                        startHdl: servObj['attrHandle' + i],
                        endHdl: servObj['endGrpHandle' + i],
                        uuid: servObj['attrVal' + i],
                        chars : []
                    });
                }
            }
        });

        return servs;
    }).then(function (servs) {
        _.forEach(servs, function (serv) {
            if (serv.startHdl === serv.endHdl) return;

            discChars.push((function () {
                return ccbnp.gatt.discAllChars(periph.connHdl, serv.startHdl, serv.endHdl).then(function (result) {
                    var charInfos = [];

                    _.forEach(result.collector.AttReadByTypeRsp, function (evtObj) {
                        var data = evtObj.data;
                        if (evtObj.status !== 0) return;

                        for(var i = 0; i < (_.keys(data).length / 2); i += 1) {
                            charInfos.push(data[['attrVal' + i]]);
                        }
                    });

                    _.forEach(charInfos, function (charInfo) {
                        var prop = [];
                        _.forEach(GATTDEFS.Prop._enumMap, function (propVal, propName) {
                            if (charInfo.prop & propVal)
                                prop.push(propName);
                        });
                        charInfo.prop = prop;
                        serv.chars.push(charInfo);
                    });
                    return;
                });
            }()));
        });

        return Q.all(discChars);
    }).done(function (result) {
        deferred.resolve(servs);
    }, function (err) {
        deferred.reject(err);
    });

    return deferred.promise;
};

ccbnpDrivers.passkeyUpdate = function (periph, passkey) {
    return ccbnp.gap.passkeyUpdate(periph.connHdl, passkey);
};

ccbnpDrivers.authenticate = function (periph, ioCap, mitm, bond) {
    var self = this,
        deferred = Q.defer(),
        keyDist = GAPDEFS.KeyDistList.get('All').value,
        cmdResult;

    bond = bond ? 0x01 : 0x00,
    mitm = mitm ? 0x04 : 0x00,

    ccbnp.gap.authenticate(periph.connHdl, ioCap, 0, new Buffer(16).fill(0), mitm | bond, 16, keyDist, 0, 0, 0, 0, 16, keyDist)
    .then(function (result) {
        deferred.resolve(result.collector.GapAuthenticationComplete[0]);        
    }).fail(function (err) {
        deferred.reject(err);
    }).done();

    return deferred.promise;
};

ccbnpDrivers.terminateAuth = function (periph) {
    return ccbnp.gap.terminateAuth(periph.connHdl, 3);
};

ccbnpDrivers.bond = function (periph, mitm, setting) {
    return ccbnp.gap.bond(periph.connHdl, mitm, setting.ltk, setting.div, setting.rand, setting.ltk.length);
};

ccbnpDrivers.read = function (char) {
    var deferred = Q.defer();

    ccbnp.gatt.readCharValue(char._service._peripheral.connHdl, char.hdl, char.uuid).done(function (result) {
        deferred.resolve(result.collector.AttReadRsp[0].value);
    }, function (err) {
        deferred.reject(err);
    });

    return deferred.promise;
};

ccbnpDrivers.read = function (char) {
    var deferred = Q.defer();

    ccbnp.gatt.readCharValue(char._service._peripheral.connHdl, char.hdl, char.uuid).done(function (result) {
        deferred.resolve(result.collector.AttReadRsp[0].value);
    }, function (err) {
        deferred.reject(err);
    });

    return deferred.promise;
};

ccbnpDrivers.readDesc = function (char) {
    var deferred = Q.defer(),
        startHdl,
        endHdl;

    startHdl = char.hdl;
    endHdl = getEndHdl(char._service, startHdl);

    ccbnp.gatt.readUsingCharUuid(char._service._peripheral.connHdl, startHdl, endHdl, '0x2901').then(function (result) {
        deferred.resolve(result.collector.AttReadByTypeRsp[0].data.attrVal0);
    }).fail(function (err) {
        deferred.reject(err);
    }).done();

    return deferred.promise;
};

ccbnpDrivers.write = function (char, value) {
    var cmd;

    if (_.includes(char.prop, 'write')) 
        cmd = 'writeCharValue';
    else if (_.includes(char.prop, 'writeWithoutResponse')) 
        cmd = 'writeNoRsp';

    return ccbnp.gatt[cmd](char._service._peripheral.connHdl, char.hdl, value, char.uuid);
};

ccbnpDrivers.notify = function (char, config) {
    var startHdl,
        endHdl;

    startHdl = char.hdl;
    endHdl = getEndHdl(char._service, startHdl); 

    if (config === false) 
        config = {properties: 0x0000};
    else if (_.includes(char.prop, 'notify') && (config === true)) 
        config = {properties: 0x0001};
    else if (_.includes(char.prop, 'indicate') && (config === true))
        config = {properties: 0x0002};

    return ccbnp.gatt.readUsingCharUuid(char._service._peripheral.connHdl, startHdl, endHdl, '0x2902').then(function (result) {
        return ccbnp.gatt.writeCharValue(char._service._peripheral.connHdl, result.collector.AttReadByTypeRsp[0].data.attrHandle0, config, '0x2902');
    });
};

ccbnpDrivers.indCfm = function (connHdl) {
    return ccbnp.att.handleValueCfm(connHdl);
};

ccbnpDrivers.regChar = function (regObj, uuid) {
    ccbnp.regChar(regObj);
};

ccbnpDrivers.regUuidHdlTable = function (periph) {
    var table = {};
    
    _.forEach(periph.servs, function (serv) {
        _.forEach(serv.chars, function (char) {
            table[char.hdl] = char.uuid;
        });
    });

    if (_.isNumber(periph.connHdl)) 
        ccbnp.regUuidHdlTable(periph.connHdl, table);
};

function getEndHdl (serv, startHdl) { 
    var endHdl = [];

    _.forEach(serv.chars, function (char) {
        if (char.hdl > startHdl) { endHdl.push(char.hdl); }
    });

    if (endHdl[0]) 
        endHdl = endHdl[0] - 1;
    else 
        endHdl = serv.endHdl;

    return endHdl;
}

module.exports = ccbnpDrivers;


// ccbnp.gap.passkeyUpdate(this._peripheral.connHdl, passkey);
// ccbnp.gap.authenticate(this._peripheral.connHdl, this.ioCap, 0, new Buffer(16).fill(0), bond | mitm, 16, keyDist, 0, 0, 0, 0, 16, keyDist)
// ccbnp.gap.terminateAuth(this._peripheral.connHdl, 3);
// ccbnp.gap.bond(this._peripheral.connHdl, mitm, this.ltk, this.div, this.rand, this.ltk.length)
// ccbnp.gap.bondSetParam(GAPDEFS.BondParam['EraseAllbonds'].value, 0, new Buffer([0]));