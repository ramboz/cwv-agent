/**
 * Generates the final action prompt for the analysis
 * @param {string} pageUrl - URL of the page being analyzed
 * @param {string} deviceType - Device type (mobile or desktop)
 * @returns {string} Final action prompt
 */
export const actionPrompt = (pageUrl, deviceType) =>`
Perform your final exhaustive and detailed analysis for url ${pageUrl} on a ${deviceType} device.
You can omit the intermediate steps and go straight to the final recommendations.
`; 