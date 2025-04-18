# search.py
import requests
from bs4 import BeautifulSoup
from typing import List, Dict, Union
import requests.utils # Import specifically for unquote

def search(query: str) -> str:
    """
    Performs a web search using DuckDuckGo for the given query.
    Returns a formatted string containing the top search results.
    Arguments:
        query (str): The search query string.
    """
    results_str = f"Search results for '{query}':\n\n"
    
    # Format the search query
    search_url = f"https://duckduckgo.com/html/?q={requests.utils.quote(query)}" # Ensure query is URL encoded
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    }
    
    try:
        # Send the request
        response = requests.get(search_url, headers=headers, timeout=10) # Added timeout
        response.raise_for_status() # Raise HTTPError for bad responses (4xx or 5xx)
        
        # Parse the HTML
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # Find all result items
        # Use a more specific selector if possible, but .result is common for DDG HTML
        result_items = soup.select(".result") 
        
        query_results = []
        for item in result_items:
            # Extract title/link and snippet
            link_element = item.select_one(".result__a")
            snippet_element = item.select_one(".result__snippet")
            
            if link_element and snippet_element:
                link = link_element.get("href", "")
                # Extract the actual URL from DDG's redirection link more robustly
                if link.startswith("/l/"): # Check for the newer redirect format
                     params = dict(x.split('=') for x in link.split('?')[1].split('&') if '=' in x)
                     uddg_link = params.get('uddg', '')
                     if uddg_link:
                         link = requests.utils.unquote(uddg_link)
                elif "/uddg=" in link: # Check for the older redirect format
                    try:
                        link_parts = link.split("/uddg=")
                        if len(link_parts) > 1:
                            link = requests.utils.unquote(link_parts[1].split("&")[0])
                    except Exception:
                        # If parsing fails, keep the original link
                        pass 
                elif link.startswith("//"): # Handle protocol-relative URLs
                    link = "https:" + link

                # Sometimes the link might still be relative, prepend domain if needed
                if link.startswith("/"):
                    link = "https://duckduckgo.com" + link # Fallback if redirect parsing failed

                title = link_element.text.strip()
                snippet = snippet_element.text.strip()
                
                # Basic cleaning of snippet
                snippet = snippet.replace("\n", " ").replace("\t", " ").strip()
                
                query_results.append({
                    "title": title,
                    "link": link,
                    "snippet": snippet
                })

        if not query_results:
            results_str += "No results found."
        else:
            for i, res in enumerate(query_results[:5], 1): # Limit to top 5 results for brevity
                results_str += f"{i}. {res['title']}\n"
                results_str += f"   Link: {res['link']}\n"
                results_str += f"   Snippet: {res['snippet']}\n\n"
                
    except requests.exceptions.RequestException as e:
        # Handle connection errors, timeouts, etc.
        print(f"Error during search request for '{query}': {e}")
        results_str += f"Error performing search: {e}"
    except Exception as e:
        # Handle other potential errors (parsing, etc.)
        print(f"Error processing search results for '{query}': {e}")
        results_str += f"Error processing search results: {e}"
        
    return results_str.strip()

# Example usage (optional, for testing)
if __name__ == "__main__":
    search_query = "what is a capybara"
    search_results = search(search_query)
    print(search_results)
    
    print("-" * 20)

    search_query_fail = "aoinweroinaergoaerg"
    search_results_fail = search(search_query_fail)
    print(search_results_fail)