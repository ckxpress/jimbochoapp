'use strict';

/* The display-grouping rule lives with the site so the browser and the build
   share one implementation: the grid folds cards with it, and the build counts
   how much folding there will be so 資料說明 states a measured figure rather
   than one typed in and left to go stale at the next rebuild. */
module.exports = require('../../site/dedupe.js');
