// A package a plugin keeps external (`chord.external`: a native addon, a package that reads its own files): the build
// leaves its import as it is, and the facet's `require` loads it from the plugin's `node_modules` at run time.

exports.where = () => __filename;
