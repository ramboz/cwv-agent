export default function evaluate({ jsApi }) {
  const results = [];
  jsApi.cspViolations.forEach((v) => {
    results.push({
      category: 'network',
      message: `Security policy violation detected`,
      url: v.blockedURI,
      recommendation: `Make sure to use the correct CSP directives to prevent security policy violations - ${v.violatedDirective} blocks ${v.blockedURI} from source ${v.sourceFile}`,
      passing: false,
    });
  });
  return results;
}