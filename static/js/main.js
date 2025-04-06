// Initialize Socket.IO connection
const socket = io();

// Constants
const MAX_STORED_POINTS = 100;  // Maximum number of points to show on the chart
const logSourceForm = document.getElementById('logSourceForm');
const logSourcesList = document.getElementById('logSourcesList');

// Initialize state variables
let currentPage = 1;
let rowsPerPage = 50;
let currentFilter = 'all';
let searchTerm = '';
let currentSourceId = null;   // Currently selected source

// Track active sources
let activeSources = new Set();

// Store logs per source
let sourceStats = new Map();  // Stats for each source
let sourceLogs = new Map();   // Logs for each source

// Initialize stats
let stats = {
    ERROR: 0,
    WARN: 0,
    INFO: 0,
    DEBUG: 0
};

// Initialize chart data
let datasets = {
    ERROR: [],
    WARN: [],
    INFO: [],
    DEBUG: []
};
let timeLabels = [];

// Update stats display
function updateStats() {
    if (currentSourceId) {
        const stats = sourceStats.get(currentSourceId) || {
            ERROR: 0,
            WARN: 0,
            INFO: 0,
            DEBUG: 0
        };
        document.getElementById('error-count').textContent = stats.ERROR;
        document.getElementById('warning-count').textContent = stats.WARN;
        document.getElementById('info-count').textContent = stats.INFO;
        document.getElementById('debug-count').textContent = stats.DEBUG;
    } else {
        // Show total stats when no source is selected
        document.getElementById('error-count').textContent = Array.from(sourceStats.values())
            .reduce((sum, stats) => sum + stats.ERROR, 0);
        document.getElementById('warning-count').textContent = Array.from(sourceStats.values())
            .reduce((sum, stats) => sum + stats.WARN, 0);
        document.getElementById('info-count').textContent = Array.from(sourceStats.values())
            .reduce((sum, stats) => sum + stats.INFO, 0);
        document.getElementById('debug-count').textContent = Array.from(sourceStats.values())
            .reduce((sum, stats) => sum + stats.DEBUG, 0);
    }
}

// Reset data for a specific source
function resetSourceData(sourceId) {
    sourceStats.set(sourceId, {
        ERROR: 0,
        WARN: 0,
        INFO: 0,
        DEBUG: 0
    });
    sourceLogs.set(sourceId, []);
}

// Reset all data
function resetData() {
    stats = {
        ERROR: 0,
        WARN: 0,
        INFO: 0,
        DEBUG: 0
    };
    sourceStats.clear();
    sourceLogs.clear();
    currentPage = 1;
    currentSourceId = null;
    
    // Reset chart data
    timeLabels = [];
    datasets = {
        ERROR: [],
        WARN: [],
        INFO: [],
        DEBUG: []
    };
    
    // Update UI
    updateStats();
    updateChartData();
    displayLogs();
}

// Update chart with new log data
function updateChart(log) {
    if (!log || !log.timestamp) return;

    const time = log.timestamp.split('T')[1].split(',')[0];
    const level = log.level === 'WARN' ? 'WARN' : log.level;
    
    if (timeLabels.length === 0 || timeLabels[timeLabels.length - 1] !== time) {
        timeLabels.push(time);
        datasets.ERROR.push(0);
        datasets.WARN.push(0);
        datasets.INFO.push(0);
        datasets.DEBUG.push(0);
        
        if (timeLabels.length > MAX_STORED_POINTS) {
            timeLabels.shift();
            datasets.ERROR.shift();
            datasets.WARN.shift();
            datasets.INFO.shift();
            datasets.DEBUG.shift();
        }
    }
    
    const lastIndex = datasets[level].length - 1;
    datasets[level][lastIndex]++;
    
    updateChartData();
}

// Update chart data
function updateChartData() {
    logActivityChart.data.labels = timeLabels;
    logActivityChart.data.datasets[0].data = datasets.ERROR;
    logActivityChart.data.datasets[1].data = datasets.WARN;
    logActivityChart.data.datasets[2].data = datasets.INFO;
    logActivityChart.data.datasets[3].data = datasets.DEBUG;
    logActivityChart.update();
}

// Update pagination
function updatePagination() {
    const totalPages = Math.ceil(filteredLogs().length / rowsPerPage);
    document.getElementById('pageInfo').textContent = `Page ${currentPage} of ${totalPages}`;
    document.getElementById('prevPage').disabled = currentPage === 1;
    document.getElementById('nextPage').disabled = currentPage >= totalPages;
}

// Filter logs based on current filter and search term
function filteredLogs() {
    let logsToFilter = [];
    
    // Get logs based on current source selection
    if (currentSourceId) {
        logsToFilter = sourceLogs.get(currentSourceId) || [];
    } else {
        // Combine all logs when no source is selected
        for (let logs of sourceLogs.values()) {
            logsToFilter = logsToFilter.concat(logs);
        }
    }
    
    // Sort combined logs by timestamp
    logsToFilter.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Apply filters
    return logsToFilter.filter(log => {
        const matchesFilter = currentFilter === 'all' || log.level === currentFilter;
        const matchesSearch = !searchTerm || 
            log.message.toLowerCase().includes(searchTerm.toLowerCase()) ||
            log.component.toLowerCase().includes(searchTerm.toLowerCase()) ||
            log.thread.toLowerCase().includes(searchTerm.toLowerCase());
        return matchesFilter && matchesSearch;
    });
}

// Display logs in the table
function displayLogs() {
    const filtered = filteredLogs();
    const start = (currentPage - 1) * rowsPerPage;
    const end = start + rowsPerPage;
    const tbody = document.getElementById('logTableBody');
    tbody.innerHTML = '';
    
    filtered.slice(start, end).forEach(log => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${log.timestamp}</td>
            <td><span class="badge bg-${getLevelClass(log.level)}">${log.level}</span></td>
            <td>${log.thread}</td>
            <td>${log.component}</td>
            <td>${log.message}</td>
        `;
        row.addEventListener('click', () => showLogDetail(log));
        tbody.appendChild(row);
    });
    
    updatePagination();
}

// Get appropriate class for log level
function getLevelClass(level) {
    switch(level) {
        case 'ERROR': return 'danger';
        case 'WARN': return 'warning';
        case 'INFO': return 'info';
        case 'DEBUG': return 'success';
        default: return 'secondary';
    }
}

// Initialize modal
const logDetailModal = new bootstrap.Modal(document.getElementById('logDetailModal'), {
    backdrop: 'static',
    keyboard: false
});

// Add modal event listeners
document.getElementById('logDetailModal').addEventListener('hidden.bs.modal', function () {
    // Clear current detail log
    currentDetailLog = null;
    // Remove modal backdrop if it exists
    const modalBackdrop = document.querySelector('.modal-backdrop');
    if (modalBackdrop) {
        modalBackdrop.remove();
    }
    // Re-enable body scrolling
    document.body.classList.remove('modal-open');
});

// Show log detail modal
// Update the showLogDetail function to properly include source_id
function showLogDetail(log) {
    // Ensure we have a source_id
    if (!log.source_id && currentSourceId) {
        log.source_id = currentSourceId;
    }
    
    // Store the current log with source_id
    currentDetailLog = {
        ...log,
        source_id: log.source_id || currentSourceId
    };
    
    console.log('Current detail log:', currentDetailLog);  // Debug log
    
    // Update modal content
    document.getElementById('detailTimestamp').textContent = log.timestamp;
    document.getElementById('detailLevel').innerHTML = `<span class="badge bg-${getLevelClass(log.level)}">${log.level}</span>`;
    document.getElementById('detailThread').textContent = log.thread;
    document.getElementById('detailComponent').textContent = log.component;
    document.getElementById('detailMessage').textContent = log.message;
    
    // Enable/disable download buttons based on source_id availability
    const downloadButtons = document.querySelectorAll('#downloadPrevious, #downloadNext');
    downloadButtons.forEach(button => {
        button.disabled = !currentDetailLog.source_id;
    });
    
    logDetailModal.show();
}
// Update the displayLogs function to include source_id when creating rows
function displayLogs() {
    const filtered = filteredLogs();
    const start = (currentPage - 1) * rowsPerPage;
    const end = start + rowsPerPage;
    const tbody = document.getElementById('logTableBody');
    tbody.innerHTML = '';
    
    filtered.slice(start, end).forEach(log => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${log.timestamp}</td>
            <td><span class="badge bg-${getLevelClass(log.level)}">${log.level}</span></td>
            <td>${log.thread}</td>
            <td>${log.component}</td>
            <td>${log.message}</td>
        `;
        row.addEventListener('click', () => {
            // Create a log object with all necessary properties including source_id
            const logWithSource = {
                timestamp: log.timestamp,
                level: log.level,
                thread: log.thread,
                component: log.component,
                message: log.message,
                source_id: log.source_id || currentSourceId // Ensure source_id is included
            };
            showLogDetail(logWithSource);
        });
        tbody.appendChild(row);
    });
    
    updatePagination();
}

// Update the downloadLogLines function for better error handling
async function downloadLogLines(direction) {
    if (!currentDetailLog || !currentDetailLog.source_id) {
        alert('No log selected. Please select a log entry first.');
        return;
    }
    
    const spinner = document.getElementById('downloadSpinner');
    spinner.classList.remove('d-none');
    
    try {
        console.log('Downloading logs for:', {
            source_id: currentDetailLog.source_id,
            timestamp: currentDetailLog.timestamp,
            direction
        });

        const response = await fetch(`/api/logs/${currentDetailLog.source_id}/${direction}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/plain, application/json'  // Accept both text and JSON responses
            },
            body: JSON.stringify({
                timestamp: currentDetailLog.timestamp,
                lines: 1000
            })
        });
        
        // Check if response is JSON (error) or blob (success)
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Failed to download logs');
        }
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const blob = await response.blob();
        if (blob.size === 0) {
            throw new Error('No log content received');
        }
        
        // Create object URL
        const url = window.URL.createObjectURL(blob);
        
        // Create and trigger download
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `${direction}_logs_${currentDetailLog.timestamp.replace(/[:.]/g, '-')}.txt`;
        
        // Append to body, click, and cleanup
        document.body.appendChild(a);
        a.click();
        
        // Cleanup
        setTimeout(() => {
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        }, 100);
        
    } catch (error) {
        console.error('Error downloading logs:', error);
        alert(error.message || 'Failed to download logs. Please try again.');
    } finally {
        spinner.classList.add('d-none');
    }
}


// Add event listeners for the download buttons
document.getElementById('downloadPrevious').addEventListener('click', () => downloadLogLines('previous'));
document.getElementById('downloadNext').addEventListener('click', () => downloadLogLines('next'));
// Add new log entry
function addLogEntry(log) {
    if (!log || !log.source_id) return;
    
    // Initialize source data if needed
    if (!sourceStats.has(log.source_id)) {
        resetSourceData(log.source_id);
    }
    
    // Update source stats
    const stats = sourceStats.get(log.source_id);
    if (!stats) return;  // Skip if source stats not found
    
    const level = log.level === 'WARN' ? 'WARN' : log.level;
    stats[level]++;
    
    // Add log to source logs
    const logs = sourceLogs.get(log.source_id);
    if (!logs) return;  // Skip if source logs not found
    
    logs.unshift(log);
    
    // Update UI only if this is the current source or no source is selected
    if (!currentSourceId || currentSourceId === log.source_id) {
        updateStats();
        updateChart(log);
        displayLogs();
    }
}

// Event listeners for log filtering
document.querySelectorAll('[data-log-type]').forEach(button => {
    button.addEventListener('click', (e) => {
        // Remove active class from all buttons
        document.querySelectorAll('[data-log-type]').forEach(btn => {
            btn.classList.remove('active');
        });
        
        // Add active class to clicked button
        e.target.classList.add('active');
        
        // Update current filter
        currentFilter = e.target.dataset.logType;
        currentPage = 1;  // Reset to first page
        displayLogs();
    });
});

// Event listener for search
document.getElementById('searchInput').addEventListener('input', (e) => {
    searchTerm = e.target.value.trim();
    currentPage = 1;  // Reset to first page
    displayLogs();
});

// Add click event to log table rows
document.getElementById('logTableBody').addEventListener('click', (e) => {
    const row = e.target.closest('tr');
    if (!row) return;
    
    const cells = row.cells;
    const log = {
        timestamp: cells[0].textContent,
        level: cells[1].querySelector('.badge').textContent,
        thread: cells[2].textContent,
        component: cells[3].textContent,
        message: cells[4].textContent,
        source_id: currentSourceId
    };
    
    showLogDetail(log);
});

// Event listeners for pagination
document.getElementById('prevPage').addEventListener('click', () => {
    if (currentPage > 1) {
        currentPage--;
        displayLogs();
    }
});

document.getElementById('nextPage').addEventListener('click', () => {
    const totalPages = Math.ceil(filteredLogs().length / rowsPerPage);
    if (currentPage < totalPages) {
        currentPage++;
        displayLogs();
    }
});

// Event listener for rows per page
document.getElementById('rowsPerPage').addEventListener('change', (e) => {
    rowsPerPage = parseInt(e.target.value);
    currentPage = 1;
    displayLogs();
});

// Create gradients
const ctx = document.getElementById('logActivityChart').getContext('2d');

const errorGradient = ctx.createLinearGradient(0, 0, 0, 400);
errorGradient.addColorStop(0, 'rgba(255, 68, 68, 0.5)');
errorGradient.addColorStop(1, 'rgba(255, 68, 68, 0.0)');

const warnGradient = ctx.createLinearGradient(0, 0, 0, 400);
warnGradient.addColorStop(0, 'rgba(255, 187, 51, 0.5)');
warnGradient.addColorStop(1, 'rgba(255, 187, 51, 0.0)');

const infoGradient = ctx.createLinearGradient(0, 0, 0, 400);
infoGradient.addColorStop(0, 'rgba(51, 181, 229, 0.5)');
infoGradient.addColorStop(1, 'rgba(51, 181, 229, 0.0)');

const debugGradient = ctx.createLinearGradient(0, 0, 0, 400);
debugGradient.addColorStop(0, 'rgba(0, 200, 81, 0.5)');
debugGradient.addColorStop(1, 'rgba(0, 200, 81, 0.0)');

// Initialize chart data
const chartData = {
    labels: timeLabels,
    datasets: [
        {
            label: 'Errors',
            data: datasets.ERROR,
            borderColor: '#ff4444',
            backgroundColor: errorGradient,
            borderWidth: 2,
            tension: 0.4,
            fill: true
        },
        {
            label: 'Warnings',
            data: datasets.WARN,
            borderColor: '#ffbb33',
            backgroundColor: warnGradient,
            borderWidth: 2,
            tension: 0.4,
            fill: true
        },
        {
            label: 'Info',
            data: datasets.INFO,
            borderColor: '#33b5e5',
            backgroundColor: infoGradient,
            borderWidth: 2,
            tension: 0.4,
            fill: true
        },
        {
            label: 'Debug',
            data: datasets.DEBUG,
            borderColor: '#00C851',
            backgroundColor: debugGradient,
            borderWidth: 2,
            tension: 0.4,
            fill: true
        }
    ]
};

// Initialize Chart.js
const logActivityChart = new Chart(ctx, {
    type: 'line',
    data: chartData,
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
            intersect: false,
            mode: 'index'
        },
        scales: {
            x: {
                grid: {
                    color: 'rgba(255, 255, 255, 0.1)'
                },
                ticks: {
                    color: 'rgba(255, 255, 255, 0.7)',
                    maxRotation: 45,
                    minRotation: 45,
                    callback: function(value, index) {
                        return index % 5 === 0 ? this.getLabelForValue(value) : '';
                    }
                }
            },
            y: {
                beginAtZero: true,
                grid: {
                    color: 'rgba(255, 255, 255, 0.1)'
                },
                ticks: {
                    color: 'rgba(255, 255, 255, 0.7)',
                    stepSize: 1
                }
            }
        },
        plugins: {
            legend: {
                display: false
            },
            tooltip: {
                mode: 'index',
                intersect: false,
                backgroundColor: 'rgba(0, 0, 0, 0.8)',
                titleColor: 'rgba(255, 255, 255, 1)',
                bodyColor: 'rgba(255, 255, 255, 0.8)',
            }
        }
    }
});

// Socket.IO event handlers
socket.on('connect', () => {
    console.log('Connected to server');
});

socket.on('log_update', (log) => {
    addLogEntry(log);
});

// Update source selection UI
function updateSourceSelection() {
    document.querySelectorAll('.log-source-item').forEach(item => {
        if (item.dataset.sourceId === currentSourceId) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
}

// Add log source to UI list
function addLogSourceToList(source) {
    const sourceElement = document.createElement('div');
    sourceElement.className = 'log-source-item';
    sourceElement.dataset.sourceId = source.id;
    sourceElement.innerHTML = `
        <div class="source-info">
            <div class="source-name">${source.name}</div>
            <div class="source-path">${source.host}:${source.log_path}</div>
        </div>
        <button class="remove-btn">
            <i class='bx bx-trash'></i>
        </button>
    `;
    
    // Add click handler for source selection
    sourceElement.querySelector('.source-info').addEventListener('click', () => {
        if (currentSourceId === source.id) {
            // Deselect source if clicking the active one
            currentSourceId = null;
        } else {
            // Select the new source
            currentSourceId = source.id;
        }
        
        // Update UI for the selected source
        updateSourceSelection();
        updateStats();
        displayLogs();
    });
    
    // Add remove button handler
    sourceElement.querySelector('.remove-btn').addEventListener('click', async (e) => {
        e.stopPropagation();  // Prevent triggering source selection
        try {
            const response = await fetch(`/api/log-sources/${source.id}`, {
                method: 'DELETE'
            });
            if (response.ok) {
                sourceElement.remove();
                activeSources.delete(source.id);
                sourceStats.delete(source.id);
                sourceLogs.delete(source.id);
                
                if (currentSourceId === source.id) {
                    currentSourceId = null;
                    updateSourceSelection();
                }
                
                if (activeSources.size === 0) {
                    resetData();
                } else {
                    updateStats();
                    displayLogs();
                }
            }
        } catch (error) {
            console.error('Error removing log source:', error);
        }
    });
    
    logSourcesList.appendChild(sourceElement);
    
    // Update selection if this is the current source
    if (source.id === currentSourceId) {
        sourceElement.classList.add('active');
    }
}

// Sidebar Toggle
const sidebarToggle = document.getElementById('sidebarToggle');
const floatingSidebar = document.getElementById('floatingSidebar');

// Toggle sidebar
sidebarToggle.addEventListener('click', () => {
    floatingSidebar.classList.toggle('active');
});

// Load existing log sources
async function loadLogSources() {
    try {
        const response = await fetch('/api/log-sources');
        if (!response.ok) {
            throw new Error('Failed to load log sources');
        }
        const sources = await response.json();
        
        // Clear existing sources
        logSourcesList.innerHTML = '';
        activeSources.clear();
        
        // Add new sources
        sources.forEach(source => {
            activeSources.add(source.id);
            resetSourceData(source.id);
            addLogSourceToList(source);
        });
        
        // Reset data if no sources
        if (activeSources.size === 0) {
            resetData();
        }
    } catch (error) {
        console.error('Error loading log sources:', error);
    }
}

// Handle form submission
logSourceForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const formData = {
        name: document.getElementById('sourceName').value,
        host: document.getElementById('sourceHost').value,
        username: document.getElementById('sourceUser').value,
        password: document.getElementById('sourcePassword').value,
        log_path: document.getElementById('sourcePath').value
    };
    
    try {
        const response = await fetch('/api/log-sources', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(formData)
        });
        
        if (response.ok) {
            const source = await response.json();
            
            // Remove existing source with same host and path if exists
            const existingElement = Array.from(logSourcesList.children)
                .find(el => {
                    const path = el.querySelector('.source-path').textContent;
                    return path === `${formData.host}:${formData.log_path}`;
                });
            if (existingElement) {
                existingElement.remove();
                const oldSourceId = existingElement.dataset.sourceId;
                activeSources.delete(oldSourceId);
                sourceStats.delete(oldSourceId);
                sourceLogs.delete(oldSourceId);
                if (currentSourceId === oldSourceId) {
                    currentSourceId = null;
                }
            }
            
            // Add new source
            activeSources.add(source.id);
            resetSourceData(source.id);
            addLogSourceToList(source);
            logSourceForm.reset();
            
            // Select the new source
            currentSourceId = source.id;
            document.querySelector(`[data-source-id="${source.id}"]`).classList.add('active');
            
            // Load initial logs for the new source
            const logsResponse = await fetch(`/api/logs/${source.id}`);
            if (logsResponse.ok) {
                const logs = await logsResponse.json();
                logs.forEach(log => addLogEntry(log));
            }
        } else {
            const error = await response.json();
            alert(`Error adding log source: ${error.error}`);
        }
    } catch (error) {
        console.error('Error adding log source:', error);
        alert('Error adding log source. Please check the console for details.');
    }
});

// Update AI Insights
function updateInsights() {
    fetch('/api/insights')
        .then(response => response.json())
        .then(insights => {
            // Update health score
            const healthScore = insights.summary.health_score;
            const healthScoreElement = document.getElementById('healthScore');
            const healthScoreGauge = document.querySelector('.health-score-gauge');
            
            healthScoreElement.textContent = healthScore;
            
            // Update health score gauge color
            healthScoreGauge.classList.remove('critical', 'warning', 'good', 'excellent');
            if (healthScore < 50) {
                healthScoreGauge.classList.add('critical');
            } else if (healthScore < 75) {
                healthScoreGauge.classList.add('warning');
            } else if (healthScore < 90) {
                healthScoreGauge.classList.add('good');
            } else {
                healthScoreGauge.classList.add('excellent');
            }
            
            // Update anomalies
            const anomaliesList = document.getElementById('anomaliesList');
            anomaliesList.innerHTML = insights.anomalies.map(anomaly => `
                <div class="insight-item ${anomaly.severity}">
                    <div class="message">${anomaly.message}</div>
                    <div class="meta">
                        <span>Severity: ${anomaly.severity}</span>
                        <span>${anomaly.type}</span>
                    </div>
                </div>
            `).join('');
            
            // Update patterns
            const patternsList = document.getElementById('patternsList');
            patternsList.innerHTML = insights.patterns.map(pattern => `
                <div class="insight-item ${pattern.severity}">
                    <div class="message">${pattern.message}</div>
                    <div class="meta">
                        <span>Severity: ${pattern.severity}</span>
                        <span>${pattern.type}</span>
                    </div>
                </div>
            `).join('');
            
            // Update summary
            const summaryList = document.getElementById('summaryList');
            summaryList.innerHTML = `
                <div class="insight-item">
                    <div class="message">
                        <div>Total Logs: ${insights.summary.total_logs}</div>
                        <div>Error Rate: ${(insights.summary.error_rate * 100).toFixed(1)}%</div>
                        <div>Warning Rate: ${(insights.summary.warning_rate * 100).toFixed(1)}%</div>
                    </div>
                </div>
            `;
            
            // Update recommendations
            const recommendationsList = document.getElementById('recommendationsList');
            recommendationsList.innerHTML = insights.recommendations.map(rec => `
                <div class="insight-item">
                    <div class="message">${rec.message}</div>
                    <div class="meta">
                        <span>${rec.type}</span>
                    </div>
                    <div class="action">${rec.action}</div>
                </div>
            `).join('');
        })
        .catch(error => console.error('Error fetching insights:', error));
}

// Update insights every 30 seconds
setInterval(updateInsights, 30000);

// Initial update
updateInsights();

// Download full logs
async function downloadFullLogs() {
    const downloadBtn = document.getElementById('downloadLogsBtn');
    const originalContent = downloadBtn.innerHTML;
    
    try {
        // Show loading state
        downloadBtn.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i><span class="ms-1">Downloading...</span>';
        downloadBtn.disabled = true;
        
        // Add source ID check
        if (!currentSourceId) {
            throw new Error('No log source selected');
        }
        
        const response = await fetch(`/api/logs/${currentSourceId}/download`, {
            method: 'GET',
            headers: {
                'Accept': 'text/plain'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        // Get filename from Content-Disposition header if present
        let filename = 'logs.txt';
        const disposition = response.headers.get('Content-Disposition');
        if (disposition && disposition.includes('filename=')) {
            const filenameMatch = disposition.match(/filename=(.+)/);
            if (filenameMatch.length > 1) {
                filename = filenameMatch[1].replace(/["']/g, '');
            }
        }
        
        // Create blob from response
        const blob = await response.blob();
        
        // Create download link
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        
        // Trigger download
        document.body.appendChild(a);
        a.click();
        
        // Cleanup
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
    } catch (error) {
        console.error('Error downloading logs:', error);
        alert(error.message || 'Failed to download logs. Please try again.');
    } finally {
        // Restore button state
        downloadBtn.innerHTML = originalContent;
        downloadBtn.disabled = false;
    }
}

// Add event listener for download button
document.getElementById('downloadLogsBtn').addEventListener('click', downloadFullLogs);

// Add event listener for download button
document.getElementById('downloadLogsBtn').addEventListener('click', downloadFullLogs);

// Initialize the application
document.addEventListener('DOMContentLoaded', async () => {
    // Load existing sources
    try {
        const response = await fetch('/api/log-sources');
        if (response.ok) {
            const sources = await response.json();
            sources.forEach(source => {
                activeSources.add(source.id);
                resetSourceData(source.id);
                addLogSourceToList(source);
            });
        }
    } catch (error) {
        console.error('Error loading log sources:', error);
    }
    
    // Initialize event listeners
    setupEventListeners();
});

// Update insights when tab is shown
document.getElementById('insights-tab').addEventListener('shown.bs.tab', () => {
    updateInsights();
});

// Update insights periodically when tab is visible
setInterval(() => {
    if (document.getElementById('insights').classList.contains('active')) {
        updateInsights();
    }
}, 30000);  // Update every 30 seconds
