'use strict';

import { debug } from './../logger';
import { DynamoDB } from 'aws-sdk';
import Joi from 'joi';
import moment from 'moment';
import base64url from 'base64-url';
import deepAssign from 'deep-assign';

const dynamoConfig = {
  region: process.env.AWS_REGION || 'us-east-1'
};
const db = new DynamoDB.DocumentClient(dynamoConfig);

class Model {

  static save(item) {
    debug('= Model.save', item);
    const itemParams = {
      TableName: this.tableName,
      Item: item,
      ReturnValues: 'ALL_OLD'
    };
    itemParams.Item.createdAt = moment().unix();
    return this._client('put', itemParams);
  }

  static saveAll(items) {
    debug('= Model.saveAll', items);
    const itemsParams = {RequestItems: {}};
    itemsParams.RequestItems[this.tableName] = items.map(item => {
      return {PutRequest: {Item: item}};
    });
    return this._client('batchWrite', itemsParams);
  }

  static get(hash, range, options = {}) {
    return new Promise((resolve, reject) => {
      debug('= Model.get', hash, range);
      const params = {
        TableName: this.tableName,
        Key: this._buildKey(hash, range)
      };
      const dbOptions = this._buildOptions(options);
      Object.assign(params, dbOptions);
      this._client('get', params).then(result => {
        if (result.Item) {
          resolve(this._refineItem(result.Item, options));
        } else {
          resolve({});
        }
      })
      .catch(err => reject(err));
    });
  }

  static _buildOptions(options) {
    debug('= Model._buildOptions', JSON.stringify(options));
    const fieldsOptions = this._fieldsOptions(options);
    return fieldsOptions;
  }

  static _fieldsOptions(options) {
    debug('= Model._fieldsOptions', JSON.stringify(options));
    const dbOptions = {};
    if (String(options.include_fields) === 'true' && options.fields) {
      const fields = options.fields.split(',');
      dbOptions.ProjectionExpression = fields.map(field => `#${field}`).join(',');
      const fieldsMapping = fields.reduce((acumm, attrName) => {
        acumm[`#${attrName}`] = attrName;
        return acumm;
      }, {});
      dbOptions.ExpressionAttributeNames = fieldsMapping;
    }
    return dbOptions;
  }

  static _refineItems(items, options) {
    debug('= Model._refineItems', JSON.stringify(options));
    if (String(options.include_fields) === 'false' && options.fields) {
      return items.map(item => this._refineItem(item, options));
    } else {
      return items;
    }
  }

  static _refineItem(item, options) {
    debug('= Model._refineItem', JSON.stringify(options));
    const refined = Object.assign({}, item);
    if (String(options.include_fields) === 'false' && options.fields) {
      const fields = options.fields.split(',');
      fields.map(field => delete refined[field]);
    }
    return refined;
  }

  static update(params, hash, range) {
    return new Promise((resolve, reject) => {
      debug('= Model.update', hash, range, JSON.stringify(params));
      const dbParams = {
        TableName: this.tableName,
        Key: this._buildKey(hash, range),
        AttributeUpdates: this._buildAttributeUpdates(params),
        ReturnValues: 'ALL_NEW'
      };
      this._client('update', dbParams).then(result => resolve(result.Attributes))
      .catch(err => reject(err));
    });
  }

  static delete(hash, range) {
    return new Promise((resolve, reject) => {
      debug('= Model.delete', hash);
      const params = {
        TableName: this.tableName,
        Key: this._buildKey(hash, range)
      };
      this._client('delete', params).then(() => resolve(true))
      .catch(err => reject(err));
    });
  }

  static allBy(key, value, options = {}) {
    return new Promise((resolve, reject) => {
      debug('= Model.allBy', key, value);
      const params = {
        TableName: this.tableName,
        KeyConditionExpression: '#hkey = :hvalue',
        ExpressionAttributeNames: {'#hkey': key},
        ExpressionAttributeValues: {':hvalue': value},
        ScanIndexForward: true
      };
      if (options.limit) {
        params.Limit = options.limit;
      }
      const page = options.page;
      if (page) {
        if (page.charAt(0) === '-') {
          const prevPage = page.substring(1, page.length);
          params.ExclusiveStartKey = this.lastEvaluatedKey(prevPage);
          params.ScanIndexForward = false;
        } else {
          params.ExclusiveStartKey = this.lastEvaluatedKey(page);
        }
      }
      const dbOptions = this._buildOptions(options);
      deepAssign(params, dbOptions);
      this._client('query', params).then((result) => {
        let prevPage;
        if (result.Items && result.Items.length > 0) {
          const pageItem = result.Items[0];
          const tempKey = {};
          tempKey[this.hashKey] = pageItem[this.hashKey];
          if (this.rangeKey) {
            tempKey[this.rangeKey] = pageItem[this.rangeKey];
          }
          prevPage = this.prevPage(tempKey);
        }
        const items = this._refineItems(result.Items, options);
        if (!params.ScanIndexForward) {
          items.reverse();
        }
        if (result.LastEvaluatedKey) {
          resolve({
            items,
            nextPage: this.nextPage(result.LastEvaluatedKey),
            prevPage
          });
        } else {
          resolve({
            items,
            prevPage
          });
        }
      })
      .catch(err => reject(err));
    });
  }

  static countBy(key, value) {
    return new Promise((resolve, reject) => {
      debug('= Model.allBy', key, value);
      const params = {
        TableName: this.tableName,
        KeyConditionExpression: '#hkey = :hvalue',
        ExpressionAttributeNames: {'#hkey': key},
        ExpressionAttributeValues: {':hvalue': value},
        Select: 'COUNT'
      };
      this._client('query', params).then((result) => {
        resolve(result.Count);
      })
      .catch(err => reject(err));
    });
  }

  static increment(attribute, count, hash, range) {
    debug('= Model.increment', hash, range, attribute, count);
    const params = {
      TableName: this.tableName,
      Key: this._buildKey(hash, range),
      AttributeUpdates: {}
    };
    params.AttributeUpdates[attribute] = {
      Action: 'ADD',
      Value: count
    };
    return this._client('update', params);
  }

  // TODO: It could be a good idea to make increment based on this
  static incrementAll(hash, range, attrValuesObj) {
    debug('= Model.incrementAttrs', hash, range, attrValuesObj);
    const params = {
      TableName: this.tableName,
      Key: this._buildKey(hash, range),
      AttributeUpdates: {}
    };
    for (let key in attrValuesObj) {
      params.AttributeUpdates[key] = {
        Action: 'ADD',
        Value: attrValuesObj[key]
      };
    }
    return this._client('update', params);
  }

  static prevPage(key) {
    return `-${new Buffer(JSON.stringify(key)).toString('base64')}`;
  }

  static nextPage(lastEvaluatedKey) {
    return base64url.encode(JSON.stringify(lastEvaluatedKey));
  }

  static lastEvaluatedKey(nextPage) {
    return JSON.parse(base64url.decode(nextPage));
  }

  static get tableName() {
    return null;
  }

  static get hashKey() {
    return 'id';
  }

  static get rangeKey() {
    return null;
  }

  static get maxRetries() {
    return 10;
  }

  static get retryDelay() {
    return 50;
  }

  static get schema() {
    return null;
  }

  static isValid(object) {
    debug('= Model.isValid');
    return this._validateSchema(this.schema, object);
  }

  static _validateSchema(schema, model) {
    if (!this.schema) return true;
    const result = Joi.validate(model, schema);
    return !result.error;
  }

  static _buildKey(hash, range) {
    let key = {};
    key[this.hashKey] = hash;
    if (this.rangeKey) {
      key[this.rangeKey] = range;
    }
    return key;
  }

  static _buildAttributeUpdates(params) {
    let attrUpdates = {};
    for (let key in params) {
      if (key !== this.hashKey && key !== this.rangeKey) {
        attrUpdates[key] = {
          Action: 'PUT',
          Value: params[key]
        };
      }
    }
    return attrUpdates;
  }

  static _client(method, params, retries = 0) {
    return new Promise((resolve, reject) => {
      debug('Model._client', JSON.stringify(params));
      this._db()[method](params, (err, data) => {
        if (err) {
          debug('= Model._client', method, 'Error', err);
          reject(err);
        } else {
          debug('= Model._client', method, 'Success');
          if (data.UnprocessedItems && Object.keys(data.UnprocessedItems).length > 0 && retries < this.maxRetries) {
            debug('= Model._client', method, 'Some unprocessed items... Retrying', JSON.stringify(data));
            const retryParams = {RequestItems: data.UnprocessedItems};
            const delay = this.retryDelay * Math.pow(2, retries);
            setTimeout(() => {
              resolve(this._client(method, retryParams, retries + 1));
            }, delay);
          } else {
            debug('= Model._client', method, 'resolving', JSON.stringify(data));
            resolve(data);
          }
        }
      });
    });
  }

  static _db() {
    return db;
  }

 }

module.exports.Model = Model;
