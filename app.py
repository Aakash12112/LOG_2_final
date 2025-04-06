from flask import Flask, render_template, jsonify, request, make_response, send_file
from flask_socketio import SocketIO
import paramiko
import threading
import re
import time
import uuid
from datetime import datetime
from collections import deque
import io

app = Flask(__name__)
socketio = SocketIO(app)

# Dictionary to store active log sources
log_sources = {}

class LogSource:
    def __init__(self, name, host, username, password, log_path):
        self.id = str(uuid.uuid4())
        self.name = name
        self.host = host
        self.username = username
        self.password = password
        self.log_path = log_path
        self.active = True
        self.connection = None
        self.thread = None
        self.last_check = time.time()
        self.processed_logs = deque(maxlen=1000)  # Keep track of last 1000 processed logs
        self.last_log_time = None
        self.logs = []  # Store logs for AI insights

    def start_monitoring(self):
        if self.thread is None or not self.thread.is_alive():
            self.active = True
            self.thread = threading.Thread(target=tail_log_file, args=(self.id,))
            self.thread.daemon = True
            self.thread.start()

    def stop_monitoring(self):
        self.active = False
        if self.connection:
            try:
                self.connection.close()
            except:
                pass
            self.connection = None

    def is_duplicate_log(self, log_hash):
        """Check if this log has been processed recently"""
        if log_hash in self.processed_logs:
            return True
        self.processed_logs.append(log_hash)
        return False

def parse_log_line(line):
    try:
        # Example log format: 2024-01-19T19:41:56,123 INFO [main] com.example.Class - Message
        pattern = r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2},\d{3})\s+(\w+)\s+\[([^\]]+)\]\s+([^\s-]+)\s*-\s*(.+)'
        match = re.match(pattern, line)
        
        if match:
            timestamp, level, thread, component, message = match.groups()
            return {
                'timestamp': timestamp,
                'level': level,
                'thread': thread,
                'component': component,
                'message': message.strip()
            }
    except Exception as e:
        print(f"Error parsing log line: {str(e)}")
    return None

def get_log_hash(log):
    """Create a unique hash for a log entry"""
    if not log:
        return None
    return f"{log['timestamp']}:{log['level']}:{log['component']}:{log['message']}"

def tail_log_file(source_id: str):
    source = log_sources.get(source_id)
    if not source:
        return

    while source.active:
        try:
            if not source.connection:
                source.connection = paramiko.SSHClient()
                source.connection.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                source.connection.connect(source.host, username=source.username, password=source.password)
            
            # Get new logs since last check
            current_time = time.time()
            time_diff = int(current_time - source.last_check + 1)
            cmd = f"find {source.log_path} -newermt '-{time_diff} seconds' -exec tail -n +1 {{}} \\;"
            stdin, stdout, stderr = source.connection.exec_command(cmd)
            
            current_log = ''
            for line in stdout:
                if not source.active:
                    break
                    
                try:
                    line = line.strip()
                    if not line:
                        continue
                        
                    if re.match(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2},\d{3}', line):
                        if current_log:
                            parsed_log = parse_log_line(current_log)
                            if parsed_log:
                                # Check if this is a new log entry
                                log_hash = get_log_hash(parsed_log)
                                if log_hash and not source.is_duplicate_log(log_hash):
                                    # Check if log is newer than last processed log
                                    log_time = datetime.strptime(parsed_log['timestamp'], '%Y-%m-%dT%H:%M:%S,%f')
                                    if not source.last_log_time or log_time > source.last_log_time:
                                        source.last_log_time = log_time
                                        parsed_log['source_id'] = source_id
                                        parsed_log['source_name'] = source.name
                                        socketio.emit('log_update', parsed_log)
                                        source.logs.append(parsed_log)
                        current_log = line
                    else:
                        current_log += '\n' + line
                except Exception as e:
                    print(f"Error processing line from {source.name}: {str(e)}")
                    continue
            
            # Process the last log entry if exists
            if current_log:
                parsed_log = parse_log_line(current_log)
                if parsed_log:
                    log_hash = get_log_hash(parsed_log)
                    if log_hash and not source.is_duplicate_log(log_hash):
                        log_time = datetime.strptime(parsed_log['timestamp'], '%Y-%m-%dT%H:%M:%S,%f')
                        if not source.last_log_time or log_time > source.last_log_time:
                            source.last_log_time = log_time
                            parsed_log['source_id'] = source_id
                            parsed_log['source_name'] = source.name
                            socketio.emit('log_update', parsed_log)
                            source.logs.append(parsed_log)
            
            source.last_check = current_time
            time.sleep(1)  # Wait 1 second before checking for new logs
                    
        except Exception as e:
            print(f"SSH connection error for {source.name}: {str(e)}")
            time.sleep(5)
        finally:
            if source.connection:
                source.connection.close()
                source.connection = None

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/log-sources', methods=['GET'])
def get_log_sources():
    sources = []
    for source_id, source in log_sources.items():
        sources.append({
            'id': source.id,
            'name': source.name,
            'host': source.host,
            'log_path': source.log_path
        })
    return jsonify(sources)

@app.route('/api/log-sources', methods=['POST'])
def add_log_source():
    try:
        data = request.json
        source = LogSource(
            name=data['name'],
            host=data['host'],
            username=data['username'],
            password=data['password'],
            log_path=data['log_path']
        )
        
        # Stop and remove any existing source with the same host and path
        for existing_id, existing_source in list(log_sources.items()):
            if existing_source.host == source.host and existing_source.log_path == source.log_path:
                existing_source.stop_monitoring()
                del log_sources[existing_id]
        
        log_sources[source.id] = source
        source.start_monitoring()
        
        return jsonify({
            'id': source.id,
            'name': source.name,
            'host': source.host,
            'log_path': source.log_path
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 400

@app.route('/api/log-sources/<source_id>', methods=['DELETE'])
def remove_log_source(source_id):
    source = log_sources.get(source_id)
    if source:
        source.stop_monitoring()
        del log_sources[source_id]
        return '', 204
    return jsonify({'error': 'Source not found'}), 404
# Updated route handlers for downloading logs
# Replace these two route handlers with the following combined handler
@app.route('/api/logs/<source_id>/<direction>', methods=['POST'])
def get_log_lines(source_id, direction):
    source = log_sources.get(source_id)
    if not source:
        return jsonify({'error': 'Source not found'}), 404
    
    try:
        data = request.json
        if not data:
            return jsonify({'error': 'No request data provided'}), 400
            
        timestamp = data.get('timestamp')
        lines = data.get('lines', 1000)
        
        if not timestamp:
            return jsonify({'error': 'Timestamp is required'}), 400
        
        print(f"Processing {direction} logs request for source {source_id} at timestamp {timestamp}")
        
        # Establish SSH connection with timeout
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            source.host,
            username=source.username,
            password=source.password,
            timeout=10
        )
        
        # Find the line with the timestamp
        find_cmd = f"grep -n '{timestamp}' {source.log_path} | head -n 1 | cut -d ':' -f 1"
        stdin, stdout, stderr = ssh.exec_command(find_cmd)
        line_number = stdout.read().decode().strip()
        
        if not line_number:
            return jsonify({'error': 'Timestamp not found in log file'}), 404
        
        line_number = int(line_number)
        
        # Calculate range based on direction
        if direction == 'previous':
            start_line = max(1, line_number - lines)
            end_line = line_number
        else:  # next
            start_line = line_number
            end_line = line_number + lines
        
        # Get the lines using tail instead of sed for better performance
        if direction == 'previous':
            cmd = f"head -n {line_number} {source.log_path} | tail -n {lines}"
        else:
            cmd = f"tail -n +{line_number} {source.log_path} | head -n {lines}"
            
        stdin, stdout, stderr = ssh.exec_command(cmd)
        
        # Read log content with timeout
        log_content = stdout.read()
        error_content = stderr.read()
        
        if error_content:
            print(f"Error from command: {error_content.decode()}")
            return jsonify({'error': 'Error reading log file'}), 500
            
        if not log_content:
            return jsonify({'error': 'No logs found in the specified range'}), 404
        
        # Create file-like object
        log_file = io.BytesIO(log_content)
        
        # Return file download response
        return send_file(
            log_file,
            mimetype='text/plain',
            as_attachment=True,
            download_name=f'{direction}_logs_{timestamp.replace(":", "-")}.txt',
            max_age=0
        )
        
    except paramiko.SSHException as e:
        print(f"SSH error: {str(e)}")
        return jsonify({'error': 'Failed to connect to log server'}), 500
    except Exception as e:
        print(f"Error processing {direction} logs: {str(e)}")
        return jsonify({'error': str(e)}), 500
    finally:
        if 'ssh' in locals():
            try:
                ssh.close()
            except:
                pass
@app.route('/api/logs/<source_id>/download', methods=['GET'])
def download_full_logs(source_id):
    source = log_sources.get(source_id)
    if not source:
        return jsonify({'error': 'Source not found'}), 404
    
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(source.host, username=source.username, password=source.password)
        
        # Use cat instead of reading the file directly to handle large files
        stdin, stdout, stderr = ssh.exec_command(f'cat {source.log_path}')
        
        # Read the output in chunks
        log_content = stdout.read()
        
        if not log_content:
            return jsonify({'error': 'Log file is empty or unreadable'}), 400
            
        # Create response with appropriate headers
        response = make_response(log_content)
        response.headers['Content-Type'] = 'text/plain'
        response.headers['Content-Disposition'] = f'attachment; filename=logs_{datetime.now().strftime("%Y%m%d_%H%M%S")}.txt'
        return response
        
    except Exception as e:
        print(f"Error downloading full logs: {str(e)}")  # Server-side logging
        return jsonify({'error': str(e)}), 500
    finally:
        if 'ssh' in locals():
            ssh.close()

@app.route('/api/logs/<source_id>', methods=['GET'])
def get_initial_logs(source_id):
    source = log_sources.get(source_id)
    if not source:
        return jsonify({'error': 'Source not found'}), 404
    
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(source.host, username=source.username, password=source.password)
        
        # Get last 100 lines of logs
        cmd = f"tail -n 100 {source.log_path}"
        stdin, stdout, stderr = ssh.exec_command(cmd)
        
        logs = []
        current_log = ''
        
        for line in stdout:
            line = line.strip()
            if not line:
                continue
                
            if re.match(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2},\d{3}', line):
                if current_log:
                    parsed_log = parse_log_line(current_log)
                    if parsed_log:
                        log_hash = get_log_hash(parsed_log)
                        if log_hash and not source.is_duplicate_log(log_hash):
                            parsed_log['source_id'] = source_id
                            parsed_log['source_name'] = source.name
                            logs.append(parsed_log)
                current_log = line
            else:
                current_log += '\n' + line
        
        # Process the last log entry
        if current_log:
            parsed_log = parse_log_line(current_log)
            if parsed_log:
                log_hash = get_log_hash(parsed_log)
                if log_hash and not source.is_duplicate_log(log_hash):
                    parsed_log['source_id'] = source_id
                    parsed_log['source_name'] = source.name
                    logs.append(parsed_log)
        
        # Sort logs by timestamp
        logs.sort(key=lambda x: x['timestamp'], reverse=True)
        return jsonify(logs)
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        ssh.close()

@app.route('/api/insights', methods=['GET'])
def get_insights():
    try:
        # Collect logs from all sources
        all_logs = []
        for source_id, source in log_sources.items():
            logs = []
            for log in source.logs:
                log_entry = {
                    'timestamp': log['timestamp'],
                    'level': log['level'],
                    'component': log.get('component', 'Unknown'),
                    'message': log['message']
                }
                logs.append(log_entry)
            all_logs.extend(logs)
        
        # Sort logs by timestamp
        all_logs.sort(key=lambda x: x['timestamp'])
        
        insights = {
            'anomalies': [],
            'patterns': [],
            'summary': {},
            'recommendations': []
        }
        
        # Analyze error patterns
        error_logs = [log for log in all_logs if log['level'] == 'ERROR']
        if error_logs:
            error_components = {}
            for log in error_logs:
                component = log['component']
                error_components[component] = error_components.get(component, 0) + 1
            
            # Find most problematic components
            problem_components = sorted(error_components.items(), key=lambda x: x[1], reverse=True)
            if problem_components:
                insights['anomalies'].append({
                    'type': 'error_hotspot',
                    'message': f"Component '{problem_components[0][0]}' has the highest error count ({problem_components[0][1]} errors)",
                    'severity': 'high'
                })
        
        # Analyze warning patterns
        warning_logs = [log for log in all_logs if log['level'] == 'WARN']
        if warning_logs:
            warning_components = {}
            for log in warning_logs:
                component = log['component']
                warning_components[component] = warning_components.get(component, 0) + 1
            
            # Find components with many warnings
            warning_hotspots = sorted(warning_components.items(), key=lambda x: x[1], reverse=True)
            if warning_hotspots:
                insights['patterns'].append({
                    'type': 'warning_pattern',
                    'message': f"Component '{warning_hotspots[0][0]}' shows repeated warnings ({warning_hotspots[0][1]} warnings)",
                    'severity': 'medium'
                })
        
        # Generate summary
        total_logs = len(all_logs)
        error_rate = len(error_logs) / total_logs if total_logs > 0 else 0
        warning_rate = len(warning_logs) / total_logs if total_logs > 0 else 0
        
        insights['summary'] = {
            'total_logs': total_logs,
            'error_rate': error_rate,
            'warning_rate': warning_rate,
            'health_score': calculate_health_score(all_logs)
        }
        
        # Generate recommendations
        if error_rate > 0.1:
            insights['recommendations'].append({
                'type': 'high_error_rate',
                'message': 'High error rate detected. Consider reviewing error handling in problematic components.',
                'action': 'Review error handling mechanisms'
            })
        
        if warning_rate > 0.2:
            insights['recommendations'].append({
                'type': 'high_warning_rate',
                'message': 'High warning rate detected. Consider upgrading or optimizing warned components.',
                'action': 'Optimize warned components'
            })
        
        # Add default insights if no issues found
        if not insights['anomalies']:
            insights['anomalies'].append({
                'type': 'system_healthy',
                'message': 'No anomalies detected. System is running smoothly.',
                'severity': 'low'
            })
        
        if not insights['patterns']:
            insights['patterns'].append({
                'type': 'normal_operation',
                'message': 'Log patterns are within normal ranges.',
                'severity': 'low'
            })
        
        if not insights['recommendations']:
            insights['recommendations'].append({
                'type': 'maintain_health',
                'message': 'System is healthy. Continue monitoring for any changes.',
                'action': 'Maintain current configuration'
            })
        
        return jsonify(insights)
        
    except Exception as e:
        print(f"Error analyzing logs: {str(e)}")
        return jsonify({'error': str(e)}), 500

def calculate_health_score(logs):
    if not logs:
        return 100
    
    # Calculate weights for different log levels
    weights = {
        'ERROR': 1.0,
        'WARN': 0.5,
        'INFO': 0.1,
        'DEBUG': 0
    }
    
    # Calculate weighted sum of log levels
    weighted_sum = 0
    total_weight = 0
    
    for log in logs:
        level = log['level']
        weight = weights.get(level, 0)
        weighted_sum += weight
        total_weight += 1
    
    if total_weight == 0:
        return 100
    
    # Calculate health score (100 is perfect health, 0 is critical)
    health_score = 100 * (1 - (weighted_sum / (total_weight * weights['ERROR'])))
    return round(max(0, min(100, health_score)), 2)

# Clear all log sources on startup
def clear_log_sources():
    log_sources.clear()

if __name__ == '__main__':
    clear_log_sources()  # Clear sources on startup
    socketio.run(app, host='0.0.0.0', port=3011, debug=True)
