---
title: "Jovian Generative AI Hackathon June 2023"
date: "2023-08-02"
articleId: "90555b12-ef3d-4fb1-826f-28667d1bd314"
slug: "jovian-generative-ai-hackathon-june-2023"
---

I attended the recent GenAI Hackathon hosted by Jovian and I thought a quick blog about my experiences would be an excellent way to share my learning experience. It was held from June 24-25, and it was exciting few days where I got to learn a bit about how to integrate LLMs, especially with React applications.

The hackathon was held in HSR Layout at their head office and was a team event. I had chosen to collaborate with a colleague of mine, [Sibaram](https://www.linkedin.com/in/sibaram-sahu-dev/). 

The session began with a brief introduction to [how LLMs worked](https://www.youtube.com/watch?v=3dZ9m6bJonM&ab_channel=Jovian) and an introduction to their LLM helper library for React called [usellm](https://youtu.be/3dZ9m6bJonM).

After the brief knowledge transfer session, my team mate and I connected for a quick brainstorming session. This is where our idea to create Merlin was born. We envisioned Merlin as a one stop solution for all the common problems faced by a developer. Like in the court of Arthur, Merlin was the grand wizard to whom Arthur turned to solve his problems, our web app is the modern equivalent of the wizard, Merlin, for a developer.

Why Use Merlin?
1. Boost Your Efficiency: With Merlin's all-in-one online solution, save time by avoiding the need to switch between multiple tools and platforms. Generate code, find solutions, and fix issues faster than ever – all in one place.
2. Superior Code Quality: By utilizing Merlin's automated unit testing and code fixing capabilities, you can ensure that your code is efficient, bug-free, and follows best practices, thus improving your overall code quality.
3. Insightful Troubleshooting: Struggling with a coding problem? Tap into the collective wisdom of developers on Stack Overflow directly through Merlin. No more wasted time searching for solutions on different sites.
4. Empower Your Learning: Merlin is not just a tool, it's a knowledge hub. Get recommendations and insights directly from Stack Overflow and Google search, and improve your coding skills in the process.
5. Break Down Knowledge Silos: Merlin's code fixing feature encourages sharing of ideas and knowledge. Instead of keeping knowledge isolated, team members can leave comments to explain their thought process, code functionality, or even specific coding techniques. This shared understanding can significantly break down knowledge silos and foster a more collaborative environment.
6. Foster Team Collaboration: With the code fixing feature, developers can easily communicate with each other within the context of the code. This can help in brainstorming, troubleshooting, or onboarding new team members, making the process seamless and efficient.

A Brief Overview of the Solution Architecture
-  Written using OpenAI’s new GPT 3.5 16K and GPT 3 (Text DaVinci)
-  Uses Specialized Prompts to Generate Code
-  Use StackOverflow and Google Custom Scraping to Generate Results
-  Written in Python(Flask) + Angular (Frontend)
-   Deployed on Firebase
Check out Merlin at this [link](https://glass-approach-204914.web.app/).


The experience building it was truly fantastic and in the end, we secured the third prize for developing the app in such a short time for an amazing idea.


