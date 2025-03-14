(() => {
    const renderRecommendation = (rec) => {
        const div = document.createElement('div');
        div.className = `recommendation ${rec.passing ? 'passing' : 'failed'}`;
        
        let html = `
            <div class="recommendation-category">${rec.category.toUpperCase()} / @${rec.time.toFixed(0)}ms</div>
            <div class="recommendation-message">${rec.message}</div>
            ${rec.recommendation ? `<div class="recommendation-text">${rec.recommendation}</div>` : ''}
            ${rec.element ? `<div class="recommendation-element"><textarea disabled>${rec.element}</textarea></div>` : ''}
        `;
        if (rec.elements) {
            rec.elements.forEach((element) => {
                html += `<div class="recommendation-element"><textarea disabled>${element}</textarea></div>`;
            });
        }
        
        div.innerHTML = html;
        return div;
    };

    const displayRecommendations = (data) => {
        const container = document.getElementById('recommendations');
        
        data.failedRules.sort((a, b) => (a.time || 0) - (b.time || 0));
        
        data.failedRules.forEach(rec => {
            container.appendChild(renderRecommendation(rec));
        });
    };

    const loadRecommendations = async () => {
        try {
            const usp = new URLSearchParams(window.location.search);
            const reportPath = usp.get('report');
            
            if (!reportPath) {
                throw new Error('No report parameter specified');
            }

            const response = await fetch(reportPath);
            const data = await response.json();
            
            displayRecommendations(data);
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