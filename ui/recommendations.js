(() => {
    const renderRecommendation = (rec) => {
        const div = document.createElement('div');
        div.className = `recommendation ${rec.passing ? 'passing' : 'failed'}`;
        
        let html = `
            <div class="recommendation-time">${rec.time ? rec.time.toFixed(0) + 'ms' : ''}</div>
            <div class="recommendation-category">${rec.category.toUpperCase()}</div>
            <div class="recommendation-message">${rec.message}</div>
            ${rec.recommendation ? `<div class="recommendation-text"><p>${rec.recommendation}</p></div>` : ''}
            <div class="recommendation-item">
        `;


        if (rec.element) {
            html += `<div class="recommendation-element"><textarea disabled>${rec.element}</textarea></div>`;
        }

        if (rec.elements) {
            rec.elements.forEach((element) => {
                html += `<div class="recommendation-element"><textarea disabled>${element}</textarea></div>`;
            });
        }

        if (rec.url) {
            html += `<div class="recommendation-url">${rec.url}</div>`;
        }

        html += `</div>`;
        
        div.innerHTML = html;
        return div;
    };

    const displayRecommendations = (url, type, data) => {
        document.title = `Performance Recommendations for ${url} on ${type}`;
        document.querySelector('h1').textContent = document.title;

        const container = document.getElementById('recommendations');
        data.sort((a, b) => (a.time || 0) - (b.time || 0));
        data.forEach(rec => {
            container.appendChild(renderRecommendation(rec));
        });
    };

    const loadRecommendations = async () => {
        try {
            const usp = new URLSearchParams(window.location.search);
            const reportPath = usp.get('rules');
            
            if (!reportPath) {
                throw new Error('No "rules" parameter specified');
            }

            const response = await fetch(reportPath);
            const report = await response.json();
            
            displayRecommendations(report.url, report.type, report.data);
        } catch (error) {
            console.error('Failed to load recommendations:', error);
            document.getElementById('recommendations').innerHTML = 
                `<div class="recommendation failed">
                    <div class="recommendation-message">Failed to load recommendations: ${error.message}</div>
                </div>`;
        }
    };

    // Start the app
    loadRecommendations();
})(); 