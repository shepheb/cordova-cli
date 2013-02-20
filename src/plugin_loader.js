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

var path            = require('path'),
    fs              = require('fs'),
    shell           = require('shelljs'),
    ls              = fs.readdirSync,
    cordova_util    = require('./util'),
    util            = require('util'),
    android_parser= require('./metadata/android_parser'),
    blackberry_parser= require('./metadata/blackberry_parser'),
    ios_parser    = require('./metadata/ios_parser'),
    et              = require('elementtree');


function codeForMapper() {
    return [
        'cordova.define("cordova-cli/runtimemapper", function(require, exports, module) {',
            'var mappings = [];',

            'exports.reset = function() { mappings = []; }',

            'function addEntry(strategy, moduleName, symbolPath) {',
                'mappings.push({ strategy: strategy, moduleName: moduleName, symbolPath: symbolPath });',
            '}',

            'function prepareNamespace(symbolPath, context) {',
                'if (!symbolPath) return context;',
                'var parts = symbolPath.split(".");',
                'var cur = context;',
                'for (var i = 0, part; part = parts[i]; ++i) {',
                    'cur[part] = cur[part] || {};',
                '}',
                'return cur[parts[i-1]];',
            '}',

            'function defineGetter(obj, key, getFunc) {',
                'if (Object.defineProperty) {',
                    'var desc = { get: getFunc, configurable: true };',
                    'Object.defineProperty(obj, key, desc);',
                '} else {',
                    'obj.__defineGetter__(key, getFunc);',
                '}',
            '}',

            'function clobber(obj, key, value) {',
                'obj[key] = value;',
                'if(obj[key] !== value) {',
                    'defineGetter(obj, key, function() { return value; });',
                '}',
            '}',

            'function recursiveMerge(target, src) {',
                'for (var prop in src) {',
                    'if (src.hasOwnProperty(prop)) {',
                        'if (target.prototype && target.prototype.constructor == target) {',
                            'clobber(target.prototype, prop, src[prop]);',
                        '} else {',
                            'if (typeof src[prop] === "object" && typeof target[prop] === "object") {',
                                'recursiveMerge(target[prop], src[prop]);',
                            '} else {',
                                'clobber(target, prop, src[prop]);',
                            '}',
                        '}',
                    '}',
                '}',
            '}',

            'exports.clobbers = function(moduleName, symbolPath) {',
                'addEntry("c", moduleName, symbolPath);',
            '}',
            'exports.merges = function(moduleName, symbolPath) {',
                'addEntry("m", moduleName, symbolPath);',
            '}',
            'exports.runs = function(moduleName) {',
                'addEntry("r", moduleName, "");',
            '}',
            'exports.mapModules = function(context) {',
                'for(var i = 0; i < symbolList.length; i++) {',
                    'var symbol = symbolList[i];',
                    'var lastDot = symbol.symbolPath.lastIndexOf(".");',
                    'var namespace = symbol.symbolPath.substr(0, lastDot);',
                    'var lastName = symbolPath.substr(lastDot + 1);',
                    'var module = require(symbol.moduleName);',
                    'var parentObj = prepareNamespace(namespace, context);',
                    'var target = parentObj[lastName];',
                    'if (strategy == "m" && target) {',
                        'recursiveMerge(target, module);',
                    '} else {',
                        'clobber(parentObj, lastName, module);',
                    '}',
                    // Note that <runs /> is handled, since we already require()d it.
                '}',
            '}',
        '});'
    ].join('\n');
}


// Called during cordova prepare.
// Sets up each plugin's Javascript code to be loaded properly.
module.exports = function plugin_loader(platform) {
    // Process:
    // - List all plugins in plugins/.
    // - Load and parse their plugin.xml files.
    // - Skip those without support for this platform.
    // - Build a list of all their js-modules, and platform-specific js-modules.
    // - For each js-module (general first, then platform):
    //   - Generate JS code to load it.
    //   - For each <clobbers>, <merges> or <runs>, generate JS code to perform it.
    //   - Copy the file, having slapped the cordova.define onto it on the way.
    // - Append all of this code to the platform's cordova.js

    var projectRoot = cordova_util.isCordova(process.cwd());
    var plugins_dir = path.join(projectRoot, 'plugins');
    var plugins = ls(plugins_dir);


    // Top-level code across plugins.
    var mapperJS = codeForMapper(); // The module mapper module.
    var js = ''; // The initially injected JS.
    var lateJS = ''; // The JS that runs after all modules are loaded.
    // Add the callback function.
    js += 'var mapper = cordova.require("cordova-cli/runtimemapper");\n';
    js += 'mapper.reset();\n'; // Should be a clean list of modules to inject.
    js += 'var scriptCounter = 0;\n';
    js += 'var scriptCallback = function() {\n';
    js += 'scriptCounter--;\n';
    js += 'if (scriptCounter == 0) { scriptsLoaded(); } };\n';

    // Acquire the platform's parser.
    var parser;
    switch(platform) {
        case 'android':
            parser = new android_parser(path.join(projectRoot, 'platforms', 'android'));
            break;
        case 'ios':
            parser = new ios_parser(path.join(projectRoot, 'platforms', 'ios'));
            break;
        case 'blackberry':
            parser = new blackberry_parser(path.join(projectRoot, 'platforms', 'blackberry'));
            break;
    }

    plugins && plugins.forEach(function(plugin) {
        var pluginDir = path.join(projectRoot, 'plugins', plugin);
        var xml = new et.ElementTree(et.XML(fs.readFileSync(path.join(pluginDir, 'plugin.xml'), 'utf-8')));

        var plugin_id = xml.getroot().attrib.id;

        // And then add the plugins dir to the platform's www.
        var platformPluginsDir = path.join(parser.www_dir(), 'plugins');
        shell.mkdir('-p', platformPluginsDir);

        var generalModules = xml.findall('./js-module');
        var platformTag = xml.find(util.format('./platform[@name="%s"]', platform));
        if (!platformTag) {
            return; // Skip plugins that don't support this platform.
        }

        var platformModules = platformTag.findall('./js-module');
        generalModules = generalModules || [];
        var allModules = generalModules.concat(platformModules);


        allModules.forEach(function(module) {
            // Copy the plugin's files into the www directory.
            var dirname = module.attrib.src;
            var lastSlash = dirname.lastIndexOf('/');
            if (lastSlash >= 0) {
                dirname = dirname.substring(0, lastSlash);
            }

            shell.mkdir('-p', path.join(platformPluginsDir, dirname));

            // Read in the file, prepend the cordova.define, and write it back out.
            var moduleName = plugin_id + '.';
            if (module.attrib.name) {
                moduleName += module.attrib.name;
            } else {
                var result = module.attrib.src.match(new RegExp('/([^/\.]+)\.js'));
                moduleName += module.attrib.name.result[1];
            }

            var scriptContent = fs.readFileSync(path.join(pluginDir, module.attrib.src), 'utf-8');
            scriptContent = 'cordova.define("' + moduleName + '", function(require, exports, module) {' + scriptContent + '});\n';
            fs.writeFileSync(path.join(platformPluginsDir, module.attrib.src), scriptContent, 'utf-8');

            // Prepare the injected Javascript code.
            var jsFile = 'plugins/' + module.attrib.src;
            js += 'scriptCounter++;\n';
            js += 'var script = document.createElement("script");\n';
            js += 'script.onload = scriptCallback;\n';
            js += 'script.src = "' + jsFile + '"\n;';
            js += 'document.querySelector("head").appendChild(script);\n';
            js += '\n';

            // Loop over the children, injecting clobber, merge and run code for each.
            module.getchildren().forEach(function(child) {
                if (child.tag.toLowerCase() == 'clobbers') {
                    lateJS += 'mapper.clobbers("' + moduleName + '", "' + child.attrib.target + '");\n';
                } else if (child.tag.toLowerCase() == 'merges') {
                    lateJS += 'mapper.merges("' + moduleName + '", "' + child.attrib.target + '");\n';
                } else if (child.tag.toLowerCase() == 'runs') {
                    lateJS += 'cordova.require("' + moduleName + '");\n';
                }
            });
            lateJS += '\n\n\n';
        });
    });

    // Wrap lateJS into scriptsLoaded(), which will be called after the last <script>
    // has finished loading.
    lateJS = 'function scriptsLoaded() {\nconsole.log("scriptsLoaded");\n' + lateJS + '\n}\n';

    // Now write the generated JS to the platform's cordova.js
    var cordovaJSPath = path.join(parser.www_dir(), 'cordova.js');
    var cordovaJS = fs.readFileSync(cordovaJSPath, 'utf-8');
    cordovaJS += '(function() { ' + mapperJS + js + lateJS + '})();';
    fs.writeFileSync(cordovaJSPath, cordovaJS, 'utf-8');
};


