
/**
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/
var cordova_util = require('./util'),
    path = require('path'),
    shell = require('shelljs'),
    config_parser = require('./config_parser'),
    android_parser = require('./metadata/android_parser'),
    ios_parser = require('./metadata/ios_parser'),
    blackberry_parser = require('./metadata/blackberry_parser'),
    fs = require('fs'),
    util = require('util'),
    http = require("http"),
    url = require("url");


function launch_server(www, platform_www, port) {
    port = port || 8000;

    // Searches these directories in order looking for the requested file.
    var searchPath = [www, platform_www];

    var server = http.createServer(function(request, response) {
        var uri = url.parse(request.url).pathname;

        function checkPath(pathIndex) {
            if (searchPath.length <= pathIndex) {
                response.writeHead(404, {"Content-Type": "text/plain"});
                response.write("404 Not Found\n");
                response.end();
                return;
            }

            var filename = path.join(searchPath[pathIndex], uri);

            fs.exists(filename, function(exists) {
                if(!exists) {
                    checkPath(pathIndex+1);
                    return;
                }

                if (fs.statSync(filename).isDirectory()) filename += path.sep + 'index.html';

                fs.readFile(filename, "binary", function(err, file) {
                    if(err) {
                        response.writeHead(500, {"Content-Type": "text/plain"});
                        response.write(err + "\n");
                        response.end();
                        return;
                    }

                    response.writeHead(200);
                    response.write(file, "binary");
                    response.end();
                });
            });
        }
        checkPath(0);
    }).listen(parseInt(''+port, 10));

    console.log("Static file server running at\n  => http://localhost:" + port + "/\nCTRL + C to shutdown");
    return server;
}

module.exports = function serve (platform, port) {
    var projectRoot = cordova_util.isCordova(process.cwd());

    if (!projectRoot) {
        throw 'Current working directory is not a Cordova-based project.';
    }

    var xml = path.join(projectRoot, 'www', 'config.xml');
    var cfg = new config_parser(xml);

    // Retrieve the platforms.
    var platforms = cordova_util.listPlatforms(projectRoot);
    if (!platform) {
        throw 'You need to specify a platform.';
    } else if (platforms.length == 0) {
        throw 'No platforms to serve.';
    } else if (platforms.filter(function(x) { return x == platform }).length == 0) {
        throw platform + ' is not an installed platform.';
    }

    // If we got to this point, the given platform is valid.

    // Default port is 8000 if not given. This is also the default of the Python module.
    port = port || 8000;

    // Top-level www directory.
    var www = projectRoot + path.sep + 'www';

    var parser, platformPath;

    // Hack for testing despite its async nature.
    var returnValue = {};
    switch (platform) {
        case 'android':
            platformPath = path.join(projectRoot, 'platforms', 'android');
            parser = new android_parser(platformPath);

            // Update the related platform project from the config
            parser.update_project(cfg);
            var platform_www = parser.www_dir();
            returnValue.server = launch_server(www, platform_www, port);
            break;
        case 'blackberry-10':
            platformPath = path.join(projectRoot, 'platforms', 'blackberry-10');
            parser = new blackberry_parser(platformPath);

            // Update the related platform project from the config
            parser.update_project(cfg, function() {
                // Shell it
                returnValue.server = launch_server(www, parser.www_dir(), port);
            });
            break;
        case 'ios':
            platformPath = path.join(projectRoot, 'platforms', 'ios');
            js = path.join(__dirname, '..', 'lib', 'ios', 'CordovaLib', 'javascript', 'cordova.ios.js');
            parser = new ios_parser(platformPath);
            // Update the related platform project from the config
            parser.update_project(cfg, function() {
                returnValue.server = launch_server(www, parser.www_dir(), port);
            });
            break;
    }
    return returnValue;
};

