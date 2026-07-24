# Logging Guide - Atomo Fordge Backend

## Overview
Comprehensive logging has been added to all JavaScript files in the backend for debugging and monitoring purposes. The logging system uses **Pino**, a high-performance JSON logger configured to output structured logs with different severity levels.

## Log Levels

All files use the following log levels (in order of severity):

| Level | Purpose | Usage |
|-------|---------|-------|
| **trace** | Most detailed, low-level debug info | Internal state changes, parsing details |
| **debug** | Diagnostic info for debugging | Function entry, parameter values, routing decisions |
| **info** | General informational messages | Successful operations, important state changes |
| **warn** | Warning conditions | Recoverable errors, unusual conditions |
| **error** | Error conditions | Exceptions, failed operations, critical issues |
| **fatal** | Critical system failures | Used by Pino for uncaught exceptions |

## Log Output Format

### Development Environment
In development mode (default), logs are pretty-printed with:
- Timestamps
- Color-coded severity levels
- Module names for filtering
- Structured data alongside messages

```
2024-07-17 14:32:15.123 INFO  [server] server started successfully {port: 3001, env: "development"}
2024-07-17 14:32:16.456 DEBUG [cameras] updating camera {reqId: "req_123", cameraId: "cam_001", updates: ["name", "url"]}
```

### Production Environment
In production (NODE_ENV=production), logs are single-line JSON for log aggregators:

```json
{"level":30,"time":"2024-07-17T14:32:15.123Z","module":"server","port":3001,"env":"production","msg":"server started successfully"}
```

## Configuration

### Environment Variables
```bash
# Log level: trace | debug | info | warn | error | fatal (default: debug in dev, info in prod)
LOG_LEVEL=debug

# Set to '0' to force plain JSON logs even in dev (skip pretty-printing)
LOG_PRETTY=1
```

## Files with Logging

### Core Application Files

#### `src/index.js`
- **trace level**: Middleware initialization, route loading
- **debug level**: Health checks, WebSocket connection attempts
- **info level**: Server startup, WebSocket established/closed
- **warn level**: Missing authentication, 404 routes
- **error level**: Unhandled exceptions

#### `src/store.js`
- **debug level**: Store initialization, camera log ring creation
- **trace level**: Individual camera log entries
- **info level**: Store initialization with counts
- Example: `log.debug({ cameraId }, 'creating new camera log ring')`

### Middleware

#### `src/middleware/auth.js` 
- **debug level**: Token verification attempts, failed auth
- **info level**: Successful logins by user
- **warn level**: Invalid/expired tokens, insufficient roles
- Already had basic logging, enhanced with more details

### Routes

#### `src/routes/cameras.js`
- **debug level**: List retrieval, camera detail fetches, stream validation
- **info level**: Camera CRUD operations, stream re-registration
- **warn level**: Camera not found, MediaMTX failures
- **error level**: Critical failures in camera setup
- All CRUD operations logged with request IDs

#### `src/routes/detect.js`
- **debug level**: Worker status checks, capability validation
- **info level**: Worker start/stop operations, config updates
- **warn level**: Missing parameters, unknown capabilities
- **error level**: Worker spawn failures

#### `src/routes/models.js`
- **debug level**: Model list retrieval
- **trace level**: Model details
- **info level**: Model initialization
- Enhanced from minimal logging

#### `src/routes/face.js`
- **debug level**: Face operations (logger added)
- Face recognition, clustering, and person management operations

#### `src/routes/auth.js` (already had logging)
- Login attempts and authentication events

### Services

#### `src/services/worker.js`
- **debug level**: Worker initialization, model type checking, file assertions
- **info level**: Worker spawn completion, process exits, config updates
- **warn level**: Worker not found, stderr output from Python processes
- **error level**: File not found, spawn failures
- **trace level**: Frame-level inference results
- Extensive logging for inference pipeline debugging

#### `src/services/mediamtx.js`
- **debug level**: Stream validation, path operations (add/patch/remove)
- **info level**: Successful MediaMTX operations
- **warn level**: Path not found, API failures
- **error level**: Critical MediaMTX errors
- **trace level**: API endpoint details, list results

#### Other Service Files
The following files should have logger initialization added where needed:
- `src/services/customModels.js`
- `src/services/faceWorkerBridge.js`
- `src/services/personStore.js`
- `src/services/systemStore.js`
- `src/services/clusterStore.js`
- `src/services/lineConfigStore.js`

## Usage Examples

### Adding Logging to New Code

```javascript
const log = require('../utils/logger').child('moduleName');

// Function entry with parameters
log.debug({ cameraId, modelId, config }, 'worker start requested');

// Successful operation
log.info({ cameraId, pid: proc.pid }, 'worker successfully started');

// Error condition
log.error({ cameraId, modelId, err }, 'worker spawn failed');

// High-frequency data (use trace)
log.trace({ cameraId, fps: result.fps }, 'inference result updated');
```

### Structured Data Pattern
Always include relevant context as an object:

```javascript
// Bad
log.info('camera created');

// Good
log.info({ reqId: req.id, cameraId: camera.id, status: camera.status }, 'camera created');
```

### Request Tracking
Use `req.id` for correlation across operations:

```javascript
log.debug({ reqId: req.id, cameraId: req.params.id }, 'fetching camera');
```

## Filtering & Monitoring

### View Logs in Development
```bash
# All logs
npm start

# Filter by module
LOG_LEVEL=debug npm start | grep '"module":"cameras"'

# View only errors
LOG_LEVEL=debug npm start | grep '"level":50'

# Watch specific camera operations
npm start | grep 'cam_001'
```

### In Production with Log Aggregator
The JSON output can be piped to tools like:
- **CloudWatch**: `aws logs put-log-events`
- **Loki**: Grafana Loki JSON parser
- **Datadog**: JSON log format ingestion
- **ELK Stack**: Elasticsearch JSON indexing

## Performance Considerations

- **trace level**: Most verbose, use only during focused debugging
- **debug level**: Development standard, minimal performance impact
- **info level**: Production standard, low overhead
- For high-frequency operations (frame-level), use `log.trace()` only when needed

## Debugging Tips

1. **Worker Issues**: Check `worker.js` logs with:
   ```
   LOG_LEVEL=trace npm start | grep worker
   ```

2. **Camera Connection Issues**: Monitor `mediamtx.js`:
   ```
   LOG_LEVEL=debug npm start | grep mediamtx
   ```

3. **API Request Flow**: Track with `req.id`:
   ```
   LOG_LEVEL=debug npm start | grep 'reqId: "req_XXX"'
   ```

4. **Authentication Issues**: Check `auth` module:
   ```
   LOG_LEVEL=debug npm start | grep '"module":"auth"'
   ```

## Next Steps

1. Add logger initialization to remaining service files
2. Add logging to `system.js` route
3. Consider adding correlation IDs for full request tracing
4. Set up log aggregation in production
5. Create dashboards for monitoring inference performance

