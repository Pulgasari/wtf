// lsd vocabulary backed by lodash. every entry is a macro, so the code comes from lodash
// and lsd only provides the names. args and sub-pipelines are forwarded:
//   chunk(2)          -> chunk(v, 2)
//   sortBy[.name]     -> sortBy(v, (v) => v.name)
//
// build:    lsd({ ops: lodash })                      (vite plugin / compile option)
// runtime:  lsd.use('lodash', _); lsd.define(lodash)

export default {
  // strings
  camel: 'lodash::camelCase',
  kebab: 'lodash::kebabCase',
  snake: 'lodash::snakeCase',
  title: 'lodash::startCase',
  deburr: 'lodash::deburr',
  slug: 'lodash::kebabCase',
  capitalize: 'lodash::upperFirst',
  truncate: 'lodash::truncate',
  pad: 'lodash::pad',
  escape: 'lodash::escape',

  // arrays
  compact: 'lodash::compact',
  unique: 'lodash::uniq',
  uniqueBy: 'lodash::uniqBy',
  chunk: 'lodash::chunk',
  flatten: 'lodash::flatten',
  flattenDeep: 'lodash::flattenDeep',
  without: 'lodash::without',
  take: 'lodash::take',
  drop: 'lodash::drop',
  sortBy: 'lodash::sortBy',
  orderBy: 'lodash::orderBy',
  groupBy: 'lodash::groupBy',
  countBy: 'lodash::countBy',
  keyBy: 'lodash::keyBy',
  partition: 'lodash::partition',
  shuffle: 'lodash::shuffle',
  sample: 'lodash::sample',

  // math
  sum: 'lodash::sum',
  sumBy: 'lodash::sumBy',
  mean: 'lodash::mean',
  min: 'lodash::min',
  max: 'lodash::max',
  minBy: 'lodash::minBy',
  maxBy: 'lodash::maxBy',
  clamp: 'lodash::clamp',

  // objects
  pick: 'lodash::pick',
  omit: 'lodash::omit',
  get: 'lodash::get',
  clone: 'lodash::cloneDeep',
  mapValues: 'lodash::mapValues',
  mapKeys: 'lodash::mapKeys',
  invert: 'lodash::invert',
  isEmpty: 'lodash::isEmpty',
};
